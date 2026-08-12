/**
 * Signup welcome email automation helpers (used by api/account.js).
 */

const { mutateStore, loadStore } = require("./store");
const { sendWelcomeEmail, welcomeCopy } = require("./mail");

const NEW_USER_WINDOW_MS = 24 * 60 * 60 * 1000;

function drainSecretOk(req, body = {}) {
  const expected = (process.env.WELCOME_DRAIN_SECRET || "").trim();
  const cronSecret = (process.env.CRON_SECRET || "").trim();
  const provided =
    (typeof req.query?.secret === "string" && req.query.secret) ||
    body.secret ||
    req.headers["x-welcome-secret"] ||
    "";
  if (expected && provided === expected) return true;

  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (expected && token === expected) return true;
    if (cronSecret && token === cronSecret) return true;
  }
  if (req.headers["x-vercel-cron"] === "1" && (expected || cronSecret)) {
    return Boolean(expected || cronSecret);
  }
  return false;
}

/** True when the request *attempted* drain auth (vs scanner with nothing). */
function hasDrainCredentials(req, body = {}) {
  if (typeof req.query?.secret === "string" && req.query.secret.trim()) return true;
  if (body && typeof body.secret === "string" && body.secret.trim()) return true;
  if (req.headers?.["x-welcome-secret"] && String(req.headers["x-welcome-secret"]).trim()) return true;
  if (req.headers?.["x-vercel-cron"] === "1") return true;
  const auth = String(req.headers?.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ") && auth.slice(7).trim()) return true;
  return false;
}

function firstNameFromUser(user) {
  const raw = user.displayName || user.name || "";
  if (raw && String(raw).trim()) return String(raw).trim().split(/\s+/)[0];
  const email = user.email || "";
  if (email.includes("@")) {
    const local = email.split("@")[0];
    if (local && !/^\d+$/.test(local)) return local.split(/[._+-]/)[0];
  }
  return "";
}

function isRecentlyCreated(creationTime) {
  if (!creationTime) return false;
  const created = new Date(creationTime).getTime();
  if (!Number.isFinite(created)) return false;
  return Date.now() - created < NEW_USER_WINDOW_MS;
}

async function claimWelcome(uid, email, firstName, source) {
  return mutateStore((store) => {
    if (!store.welcome_emails) store.welcome_emails = {};
    const existing = store.welcome_emails[uid];
    if (existing && (existing.status === "sent" || existing.status === "pending")) {
      return { claimed: false, record: existing };
    }
    const record = {
      uid,
      email,
      first_name: firstName || "",
      status: "pending",
      source: source || "signup",
      queued_at: new Date().toISOString(),
      sent_at: null,
      provider: null,
      error: null,
    };
    store.welcome_emails[uid] = record;
    return { claimed: true, record };
  });
}

async function markWelcome(uid, patch) {
  return mutateStore((store) => {
    if (!store.welcome_emails) store.welcome_emails = {};
    const prev = store.welcome_emails[uid] || { uid };
    store.welcome_emails[uid] = { ...prev, ...patch };
    return store.welcome_emails[uid];
  });
}

async function handleSignupWelcome(req, body, user) {
  const email = (user.email || body.email || "").trim();
  if (!email) {
    const err = new Error("User has no email");
    err.status = 422;
    throw err;
  }

  const forceNew = body.is_new_user === true || body.is_new_user === "true";
  const createdAt = body.creation_time || null;
  const recent = forceNew || isRecentlyCreated(createdAt);

  const existingStore = await loadStore();
  const prior = existingStore.welcome_emails?.[user.uid];
  if (prior?.status === "sent") {
    return { ok: true, sent: false, reason: "already_sent" };
  }
  if (prior?.status === "pending") {
    return { ok: true, sent: false, reason: "already_queued", queued: true };
  }
  if (!recent && !forceNew) {
    return { ok: true, sent: false, reason: "not_new_user" };
  }

  const firstName = (
    body.first_name ||
    firstNameFromUser({ ...user, displayName: body.display_name })
  ).trim();
  const { claimed } = await claimWelcome(
    user.uid,
    email,
    firstName,
    body.source || "dashboard_signup"
  );
  if (!claimed) {
    return { ok: true, sent: false, reason: "already_queued" };
  }

  const result = await sendWelcomeEmail({ email, firstName });
  if (result.ok) {
    await markWelcome(user.uid, {
      status: "sent",
      sent_at: new Date().toISOString(),
      provider: result.provider || "resend",
      error: null,
    });
    return { ok: true, sent: true, provider: result.provider };
  }

  await markWelcome(user.uid, {
    status: "pending",
    provider: null,
    error: result.error || "queued_for_drain",
  });
  return {
    ok: true,
    sent: false,
    queued: true,
    reason: "queued",
    detail: result.error || "Queued for drain worker",
  };
}

async function listPendingWelcomes() {
  const store = await loadStore();
  return Object.values(store.welcome_emails || {})
    .filter((r) => r && r.status === "pending" && r.email)
    .map((r) => {
      const copy = welcomeCopy({ firstName: r.first_name, email: r.email });
      return {
        uid: r.uid,
        email: r.email,
        first_name: r.first_name || "",
        subject: copy.subject,
        body: copy.text,
        html: copy.html,
        queued_at: r.queued_at || null,
      };
    });
}

async function drainPendingWelcomes() {
  const store = await loadStore();
  const pending = Object.values(store.welcome_emails || {}).filter(
    (r) => r && r.status === "pending" && r.email
  );

  let sent = 0;
  let failed = 0;
  for (const rec of pending) {
    const result = await sendWelcomeEmail({
      email: rec.email,
      firstName: rec.first_name || "",
    });
    if (result.ok) {
      await markWelcome(rec.uid, {
        status: "sent",
        sent_at: new Date().toISOString(),
        provider: result.provider || "resend",
        error: null,
      });
      sent += 1;
    } else {
      failed += 1;
    }
  }
  return { pending: pending.length, sent, failed };
}

module.exports = {
  drainSecretOk,
  hasDrainCredentials,
  handleSignupWelcome,
  listPendingWelcomes,
  markWelcome,
  drainPendingWelcomes,
};
