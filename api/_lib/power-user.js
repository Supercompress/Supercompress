/**
 * Once-ever power-user email when usage reaches 1M tokens.
 * Durable on Auth claims (`sc_power_mail`) + Resend Idempotency-Key so it
 * still sends when Firestore / config-store is down.
 */

const POWER_USER_TOKENS = 1_000_000;
const POWER_MAIL_CLAIM = "sc_power_mail";
const DRAIN_AUTH_CAP = 40;

function firstNameFromUser(user = {}) {
  const raw = user.displayName || user.name || "";
  if (raw && String(raw).trim()) return String(raw).trim().split(/\s+/)[0];
  const email = user.email || "";
  if (email.includes("@")) {
    const local = email.split("@")[0];
    if (local && !/^\d+$/.test(local)) return local.split(/[._+-]/)[0];
  }
  return "";
}

function crossedPowerUser(prevTokens, nextTokens, threshold = POWER_USER_TOKENS) {
  const prev = Number(prevTokens) || 0;
  const next = Number(nextTokens) || 0;
  return prev < threshold && next >= threshold;
}

function powerMailAlreadySent(claims = {}) {
  return String(claims?.[POWER_MAIL_CLAIM] || "") === "sent";
}

/** True if they are at/over 1M and we have not stamped a successful send. */
function shouldNotifyPowerUser(prevTokens, nextTokens, claims = {}, threshold = POWER_USER_TOKENS) {
  if (powerMailAlreadySent(claims)) return false;
  const prev = Number(prevTokens) || 0;
  const next = Number(nextTokens) || 0;
  return next >= threshold || prev >= threshold;
}

function statsFromUsage({ tokensIn, tokensSaved, requests } = {}) {
  const tin = Math.max(0, Number(tokensIn) || 0);
  const saved = Math.max(0, Number(tokensSaved) || 0);
  const reqs = Math.max(0, Number(requests) || 0);
  const cutPct = tin > 0 ? Math.round((saved / tin) * 100) : 0;
  const denom = Math.max(1, tin - saved);
  const morePct = tin > saved ? Math.round((tin / denom - 1) * 100) : 0;
  return { tokensIn: tin, tokensSaved: saved, requests: reqs, cutPct, morePct };
}

function powerUserIdempotencyKey(uid) {
  return `power-user-${String(uid || "").trim()}`;
}

async function claimPowerUser(uid, extra = {}) {
  if (!uid) return { claimed: false, record: null, reason: "no_uid" };
  try {
    const { mutateStore } = require("./store");
    return await mutateStore((store) => {
      if (!store.power_user_emails) store.power_user_emails = {};
      const existing = store.power_user_emails[uid];
      if (existing && existing.status && existing.status !== "failed") {
        return { claimed: false, record: existing, reason: existing.status };
      }
      const record = {
        ...(existing || {}),
        uid,
        status: "pending",
        claimed_at: existing?.claimed_at || new Date().toISOString(),
        retried_at: existing ? new Date().toISOString() : null,
        idempotency_key: existing?.idempotency_key || powerUserIdempotencyKey(uid),
        ...extra,
      };
      store.power_user_emails[uid] = record;
      return { claimed: true, record };
    });
  } catch (err) {
    const record = {
      uid,
      status: "pending",
      claimed_at: new Date().toISOString(),
      idempotency_key: powerUserIdempotencyKey(uid),
      store_error: err.message || "store_unavailable",
      ...extra,
    };
    return { claimed: true, record, reason: "claims_fallback" };
  }
}

async function markPowerUser(uid, patch) {
  try {
    const { mutateStore } = require("./store");
    return await mutateStore((store) => {
      if (!store.power_user_emails) store.power_user_emails = {};
      const prev = store.power_user_emails[uid] || { uid };
      store.power_user_emails[uid] = { ...prev, ...patch };
      return store.power_user_emails[uid];
    });
  } catch (err) {
    return { uid, ...patch, store_error: err.message || "store_unavailable" };
  }
}

async function stampPowerMailSent(uid) {
  if (!uid) return false;
  const { initFirebaseAdmin } = require("./auth");
  const admin = require("firebase-admin");
  if (!initFirebaseAdmin()) return false;
  const { setBillingClaims } = require("./billing-ledger");
  for (let i = 0; i < 3; i++) {
    const user = await admin.auth().getUser(uid);
    const prev = user.customClaims || {};
    if (prev[POWER_MAIL_CLAIM] === "sent") return true;
    await setBillingClaims(uid, { ...prev, [POWER_MAIL_CLAIM]: "sent" });
    const after = await admin.auth().getUser(uid);
    if ((after.customClaims || {})[POWER_MAIL_CLAIM] === "sent") return true;
  }
  return false;
}

function isDrainablePowerUser(rec) {
  if (!rec || !rec.uid) return false;
  if (rec.status !== "pending" && rec.status !== "failed" && rec.status !== "sending") {
    return false;
  }
  return String(rec.email || "").includes("@");
}

async function deliverPowerUser(rec) {
  const { sendPowerUserEmail } = require("./mail");
  const uid = rec.uid;
  const idempotencyKey = rec.idempotency_key || powerUserIdempotencyKey(uid);
  await markPowerUser(uid, {
    status: "sending",
    send_attempt_at: new Date().toISOString(),
    idempotency_key: idempotencyKey,
  });

  const firstName =
    rec.first_name || firstNameFromUser({ email: rec.email, displayName: rec.display_name });
  const result = await sendPowerUserEmail({
    email: rec.email,
    firstName,
    idempotencyKey,
    ...statsFromUsage({
      tokensIn: rec.tokens_in,
      tokensSaved: rec.tokens_saved,
      requests: rec.requests,
    }),
  });

  if (result.ok) {
    try {
      await stampPowerMailSent(uid);
    } catch (err) {
      console.warn("power-user claim stamp failed:", err.message || err);
    }
    await markPowerUser(uid, {
      status: "sent",
      sent_at: new Date().toISOString(),
      provider: result.provider || "resend",
      provider_id: result.id || null,
      error: null,
    });
    return { ok: true };
  }

  await markPowerUser(uid, {
    status: "pending",
    error: result.error || "send_failed",
    failed_at: new Date().toISOString(),
  });
  return { ok: false, error: result.error || "send_failed" };
}

async function maybeNotifyPowerUser({
  uid,
  email,
  displayName,
  prevTokens,
  nextTokens,
  tokensSaved,
  requests,
  source = "compress",
  claims = null,
} = {}) {
  if (!uid) return { ok: true, sent: false, reason: "no_uid" };

  const { initFirebaseAdmin } = require("./auth");
  const admin = require("firebase-admin");
  let live = claims || {};
  let to = String(email || "").trim();
  let name = displayName;
  if (initFirebaseAdmin()) {
    try {
      const user = await admin.auth().getUser(uid);
      live = user.customClaims || live;
      if (!to) to = String(user.email || "").trim();
      if (!name) name = user.displayName || "";
    } catch (_) {
      /* use caller-provided claims */
    }
  }

  if (powerMailAlreadySent(live)) {
    return { ok: true, sent: false, reason: "already_sent" };
  }
  if (!shouldNotifyPowerUser(prevTokens, nextTokens, live)) {
    return { ok: true, sent: false, reason: "not_crossed" };
  }

  const firstName = firstNameFromUser({ displayName: name, email: to });
  const extra = {
    email: to,
    first_name: firstName,
    tokens_in: Number(nextTokens) || Number(live.sc_usage?.tokens_in || 0),
    tokens_saved: Number(tokensSaved) || Number(live.sc_usage?.tokens_saved || 0),
    requests: Number(requests) || Number(live.sc_usage?.requests || 0),
    source,
  };
  const { record } = await claimPowerUser(uid, extra);

  if (!to.includes("@")) {
    await markPowerUser(uid, {
      status: "skipped_no_email",
      skipped_at: new Date().toISOString(),
    });
    return { ok: true, sent: false, reason: "no_email" };
  }

  const result = await deliverPowerUser({ ...record, ...extra, email: to });
  if (result.ok) return { ok: true, sent: true };
  return { ok: false, sent: false, queued: true, reason: result.error || "send_failed" };
}

function isStubUid(uid) {
  return /^(sck_|sc_at_|sc_ac_|sc_aff_)/.test(String(uid || ""));
}

async function drainAuthPowerUsers({ cap = DRAIN_AUTH_CAP } = {}) {
  const { initFirebaseAdmin } = require("./auth");
  const admin = require("firebase-admin");
  if (!initFirebaseAdmin()) return { scanned: 0, mailed: 0, skipped: 0, error: "no_admin" };

  let scanned = 0;
  let mailed = 0;
  let skipped = 0;
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    for (const user of page.users) {
      if (mailed >= cap) break;
      if (isStubUid(user.uid) || user.disabled) continue;
      const email = String(user.email || "").trim().toLowerCase();
      if (!email.includes("@") || email.includes("noreply")) continue;
      const claims = user.customClaims || {};
      if (powerMailAlreadySent(claims)) {
        skipped += 1;
        continue;
      }
      const tin = Number(claims.sc_usage?.tokens_in || 0);
      if (tin < POWER_USER_TOKENS) continue;
      scanned += 1;
      const result = await maybeNotifyPowerUser({
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || "",
        prevTokens: tin,
        nextTokens: tin,
        tokensSaved: claims.sc_usage?.tokens_saved,
        requests: claims.sc_usage?.requests,
        source: "drain",
        claims,
      });
      if (result.sent) mailed += 1;
    }
    pageToken = mailed >= cap ? null : page.pageToken;
  } while (pageToken);

  return { scanned, mailed, skipped };
}

/**
 * Retry store-queued sends, then mail anyone already over 1M with no sent stamp.
 */
async function drainPendingPowerUsers() {
  let storePending = 0;
  let storeSent = 0;
  let storeFailed = 0;
  let storeError = null;
  try {
    const { loadStore } = require("./store");
    const store = await loadStore();
    const pending = Object.values(store.power_user_emails || {}).filter(isDrainablePowerUser);
    storePending = pending.length;
    for (const rec of pending) {
      const result = await deliverPowerUser(rec);
      if (result.ok) storeSent += 1;
      else storeFailed += 1;
    }
  } catch (err) {
    storeError = err.message || "store_unavailable";
  }

  const authDrain = await drainAuthPowerUsers();
  return {
    pending: storePending,
    sent: storeSent,
    failed: storeFailed,
    store_error: storeError,
    auth: authDrain,
  };
}

function schedulePowerUserEmail(opts) {
  void maybeNotifyPowerUser(opts).catch((err) => {
    console.warn("power-user email skipped:", err.message || err);
  });
}

module.exports = {
  POWER_USER_TOKENS,
  POWER_MAIL_CLAIM,
  crossedPowerUser,
  powerMailAlreadySent,
  shouldNotifyPowerUser,
  statsFromUsage,
  firstNameFromUser,
  isDrainablePowerUser,
  claimPowerUser,
  markPowerUser,
  maybeNotifyPowerUser,
  drainPendingPowerUsers,
  drainAuthPowerUsers,
  schedulePowerUserEmail,
  stampPowerMailSent,
  powerUserIdempotencyKey,
};
