/**
 * Weekly product email for all signed-up users (used by api/account.js).
 * Enqueues by ISO week; drains via Resend when configured, otherwise
 * queues for the gog Gmail drain script.
 */

const crypto = require("crypto");
const { mutateStore, loadStore } = require("./store");
const { sendWeeklyEmail, weeklyEmailCopy, campaignKind } = require("./mail");
const { drainSecretOk } = require("./welcome");

const BATCH_SIZE = Math.max(
  5,
  Math.min(40, Number(process.env.WEEKLY_EMAIL_BATCH || 25) || 25)
);

const ENQUEUE_CHUNK = 20;

function isoWeekCampaignId(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday in current week decides the year
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/** Sunday tip campaign — custom product email */
function tipCampaignId(date = new Date()) {
  return `${isoWeekCampaignId(date)}-tip`;
}

/** Wednesday changelog / shipped-this-week campaign */
function shipCampaignId(date = new Date()) {
  return `${isoWeekCampaignId(date)}-ship`;
}

/**
 * Resolve which campaign to run.
 * force: 'tip' | 'ship' | 'drain' | campaign id ending in -tip/-ship
 * Default: tip on Sunday (0), ship on Wednesday (3); other days drain-only.
 */
function resolveCampaign(opts = {}) {
  const force = String(opts.force || process.env.WEEKLY_FORCE_KIND || "").trim().toLowerCase();
  const utcDay = new Date().getUTCDay();
  if (force === "drain" || force === "none") {
    return { kind: null, campaignId: null, utcDay, reason: "force_drain" };
  }
  if (force === "tip" || force.endsWith("-tip")) {
    const id = force.includes("-") && force !== "tip" ? force : tipCampaignId();
    return { kind: "tip", campaignId: id, utcDay, reason: "force_tip" };
  }
  if (force === "ship" || force.endsWith("-ship")) {
    const id = force.includes("-") && force !== "ship" ? force : shipCampaignId();
    return { kind: "ship", campaignId: id, utcDay, reason: "force_ship" };
  }
  if (utcDay === 0) {
    return { kind: "tip", campaignId: tipCampaignId(), utcDay, reason: "sunday_tip" };
  }
  if (utcDay === 3) {
    return { kind: "ship", campaignId: shipCampaignId(), utcDay, reason: "wednesday_ship" };
  }
  return { kind: null, campaignId: null, utcDay, reason: "off_day_drain" };
}

function unsubSecret() {
  return (
    (process.env.WELCOME_DRAIN_SECRET || "").trim() ||
    (process.env.CRON_SECRET || "").trim() ||
    "supercompress-weekly"
  );
}

function unsubToken(email) {
  return crypto
    .createHmac("sha256", unsubSecret())
    .update(String(email || "").trim().toLowerCase())
    .digest("hex")
    .slice(0, 32);
}

function unsubUrlFor(email) {
  const e = encodeURIComponent(String(email || "").trim().toLowerCase());
  const t = unsubToken(email);
  return `https://www.supercompress.dev/unsubscribe?email=${e}&token=${t}`;
}

/** RFC 8058 one-click target (POST with query email+token). */
function unsubApiUrlFor(email) {
  const e = encodeURIComponent(String(email || "").trim().toLowerCase());
  const t = unsubToken(email);
  return `https://www.supercompress.dev/api/weekly/unsubscribe?email=${e}&token=${t}`;
}

function verifyUnsubToken(email, token) {
  if (!email || !token) return false;
  const expected = unsubToken(email);
  const got = String(token).trim().toLowerCase();
  // timingSafeEqual throws on length mismatch — treat as invalid, don't throw up.
  if (got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}

function isUnsubscribed(store, email) {
  const clean = String(email || "").trim().toLowerCase();
  if (!clean) return false;
  const map = store?.weekly_unsubscribes || {};
  return Boolean(map[clean]);
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

function isStubUid(uid) {
  const u = String(uid || "");
  return (
    u.startsWith("sck_") ||
    u.startsWith("sc_aff_") ||
    u.startsWith("sc_at_") ||
    u.startsWith("sc_ac_")
  );
}

function hasResendKey() {
  return Boolean((process.env.RESEND_API_KEY || "").trim());
}

async function listAuthRecipients() {
  const admin = require("firebase-admin");
  const { initFirebaseAdmin } = require("./auth");
  if (!initFirebaseAdmin()) {
    const err = new Error("Firebase Admin not configured — cannot list users for weekly email");
    err.status = 503;
    throw err;
  }
  const auth = admin.auth();
  const out = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      if (!user.email || user.disabled || isStubUid(user.uid)) continue;
      // Skip obviously non-human stubs
      if (user.email.includes("noreply") || user.email.endsWith(".local")) continue;
      out.push({
        uid: user.uid,
        email: String(user.email).trim().toLowerCase(),
        first_name: firstNameFromUser(user),
      });
    }
    pageToken = page.pageToken;
  } while (pageToken);

  // Also include anyone who got a welcome email (covers edge cases)
  const store = await loadStore();
  for (const rec of Object.values(store.welcome_emails || {})) {
    if (!rec?.email || !rec?.uid || isStubUid(rec.uid)) continue;
    const email = String(rec.email).trim().toLowerCase();
    if (!email.includes("@")) continue;
    if (out.some((r) => r.uid === rec.uid || r.email === email)) continue;
    out.push({
      uid: rec.uid,
      email,
      first_name: rec.first_name || "",
    });
  }
  return out;
}

/**
 * Enqueue in chunks of ENQUEUE_CHUNK to avoid GitHub gist 409 conflicts
 * on large mutateStore writes.
 */
async function enqueueWeeklyCampaign(campaignId = isoWeekCampaignId()) {
  const recipients = await listAuthRecipients();
  let queued = 0;
  let skipped = 0;

  for (let i = 0; i < recipients.length; i += ENQUEUE_CHUNK) {
    const chunk = recipients.slice(i, i + ENQUEUE_CHUNK);
    const result = await mutateStore((store) => {
      if (!store.weekly_emails) store.weekly_emails = {};
      if (!store.weekly_unsubscribes) store.weekly_unsubscribes = {};

      let chunkQueued = 0;
      let chunkSkipped = 0;
      for (const r of chunk) {
        const key = `${campaignId}:${r.uid}`;
        if (isUnsubscribed(store, r.email)) {
          chunkSkipped += 1;
          continue;
        }
        const existing = store.weekly_emails[key];
        if (existing && (existing.status === "sent" || existing.status === "pending")) {
          chunkSkipped += 1;
          continue;
        }
        store.weekly_emails[key] = {
          key,
          campaign_id: campaignId,
          uid: r.uid,
          email: r.email,
          first_name: r.first_name || "",
          status: "pending",
          queued_at: new Date().toISOString(),
          sent_at: null,
          provider: null,
          error: null,
        };
        chunkQueued += 1;
      }
      return { chunkQueued, chunkSkipped };
    });
    queued += result?.chunkQueued || 0;
    skipped += result?.chunkSkipped || 0;
  }

  const store = await loadStore();
  const pending = Object.values(store.weekly_emails || {}).filter(
    (r) => r.campaign_id === campaignId && r.status === "pending"
  ).length;
  return {
    campaign_id: campaignId,
    recipients: recipients.length,
    queued,
    skipped,
    pending,
  };
}

async function markWeekly(key, patch) {
  return mutateStore((store) => {
    if (!store.weekly_emails) store.weekly_emails = {};
    const prev = store.weekly_emails[key] || { key };
    store.weekly_emails[key] = { ...prev, ...patch };
    return store.weekly_emails[key];
  });
}

async function listPendingWeekly(campaignId, { includeHtml = true } = {}) {
  const store = await loadStore();
  const cid = campaignId || null;
  return Object.values(store.weekly_emails || {})
    .filter((r) => r && r.status === "pending" && r.email && (!cid || r.campaign_id === cid))
    .map((r) => {
      const copy = weeklyEmailCopy({
        firstName: r.first_name,
        email: r.email,
        campaignId: r.campaign_id,
        unsubUrl: unsubUrlFor(r.email),
      });
      const row = {
        key: r.key,
        uid: r.uid,
        email: r.email,
        first_name: r.first_name || "",
        campaign_id: r.campaign_id,
        kind: campaignKind(r.campaign_id),
        subject: copy.subject,
        body: copy.text,
        queued_at: r.queued_at || null,
      };
      if (includeHtml) row.html = copy.html;
      return row;
    });
}

async function drainPendingWeekly({ limit = BATCH_SIZE, campaignId } = {}) {
  if (!hasResendKey()) {
    return {
      batch: 0,
      sent: 0,
      failed: 0,
      remaining: null,
      errors: [{ error: "RESEND_API_KEY not configured — use gog drain" }],
      mode: "enqueue_only",
    };
  }

  const store = await loadStore();
  const cid = campaignId || null;
  const pending = Object.values(store.weekly_emails || {})
    .filter(
      (r) =>
        r &&
        r.status === "pending" &&
        r.email &&
        (!cid || r.campaign_id === cid) &&
        !isUnsubscribed(store, r.email)
    )
    .sort((a, b) => String(a.queued_at || "").localeCompare(String(b.queued_at || "")))
    .slice(0, limit);

  let sent = 0;
  let failed = 0;
  const errors = [];

  for (const rec of pending) {
    const result = await sendWeeklyEmail({
      email: rec.email,
      firstName: rec.first_name || "",
      campaignId: rec.campaign_id,
      unsubUrl: unsubUrlFor(rec.email),
      listUnsubscribeUrl: unsubApiUrlFor(rec.email),
    });
    if (result.ok) {
      await markWeekly(rec.key, {
        status: "sent",
        sent_at: new Date().toISOString(),
        provider: result.provider || "resend",
        tip_id: result.tip_id || null,
        error: null,
      });
      sent += 1;
    } else {
      failed += 1;
      errors.push({ email: rec.email, error: result.error || "send_failed" });
      await markWeekly(rec.key, {
        error: result.error || "send_failed",
      });
    }
  }

  const remainingStore = await loadStore();
  const remaining = Object.values(remainingStore.weekly_emails || {}).filter(
    (r) => r.status === "pending" && r.email
  ).length;

  return {
    batch: pending.length,
    sent,
    failed,
    remaining,
    errors: errors.slice(0, 5),
  };
}

/**
 * Sunday tip / Wednesday ship tick.
 * force: tip | ship | drain | full campaign id (e.g. 2026-W32-ship)
 * Without RESEND_API_KEY: enqueue only (gog drain sends).
 * With key: send up to BATCH_SIZE via Resend.
 * Off-schedule days: drain pending only (no new enqueue).
 */
async function weeklyTick(opts = {}) {
  const resolved = resolveCampaign(opts);
  const { kind, campaignId, utcDay, reason } = resolved;

  // Off-day / drain-only: clear backlog if Resend is configured
  if (!kind || !campaignId) {
    if (!hasResendKey()) {
      return {
        ok: true,
        mode: "drain_only",
        kind: null,
        campaign_id: null,
        utc_day: utcDay,
        reason,
        sent: 0,
        failed: 0,
        remaining: null,
        errors: [],
        note: "No campaign today (tips = Sunday, ship = Wednesday). Drain pending with gog if needed.",
      };
    }
    const drain = await drainPendingWeekly({ limit: BATCH_SIZE });
    return {
      ok: true,
      mode: "drain_only",
      kind: null,
      campaign_id: null,
      utc_day: utcDay,
      reason,
      ...drain,
      drain,
    };
  }

  // No Resend → queue for gog drain instead of burning failed attempts
  if (!hasResendKey()) {
    const enqueue = await enqueueWeeklyCampaign(campaignId);
    return {
      ok: true,
      mode: "enqueue_only",
      kind,
      campaign_id: campaignId,
      utc_day: utcDay,
      reason,
      recipients: enqueue.recipients,
      queued: enqueue.queued,
      skipped: enqueue.skipped,
      pending: enqueue.pending,
      sent: 0,
      failed: 0,
      remaining: enqueue.pending,
      errors: [],
      drain: { sent: 0, failed: 0, remaining: enqueue.pending, batch: 0, mode: "enqueue_only" },
      enqueue,
      note: "RESEND_API_KEY not configured — queued for gog drain",
    };
  }

  const recipients = await listAuthRecipients();
  const store = await loadStore();
  const unsubs = store.weekly_unsubscribes || {};
  const records = store.weekly_emails || {};

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const errors = [];

  for (const r of recipients) {
    if (sent + failed >= BATCH_SIZE) break;
    const key = `${campaignId}:${r.uid}`;
    if (isUnsubscribed({ weekly_unsubscribes: unsubs }, r.email)) {
      skipped += 1;
      continue;
    }
    if (records[key]?.status === "sent") {
      skipped += 1;
      continue;
    }

    const result = await sendWeeklyEmail({
      email: r.email,
      firstName: r.first_name || "",
      campaignId,
      unsubUrl: unsubUrlFor(r.email),
      listUnsubscribeUrl: unsubApiUrlFor(r.email),
    });

    if (result.ok) {
      try {
        await markWeekly(key, {
          key,
          campaign_id: campaignId,
          uid: r.uid,
          email: r.email,
          first_name: r.first_name || "",
          status: "sent",
          queued_at: records[key]?.queued_at || new Date().toISOString(),
          sent_at: new Date().toISOString(),
          provider: result.provider || "resend",
          tip_id: result.tip_id || null,
          kind,
          error: null,
        });
      } catch (markErr) {
        // Send succeeded — don't retry forever if store is flaky
        errors.push({ email: r.email, error: `sent_but_mark_failed: ${markErr.message}` });
      }
      sent += 1;
      records[key] = { status: "sent" }; // local skip if we continue
    } else {
      failed += 1;
      errors.push({ email: r.email, error: result.error || "send_failed" });
      try {
        await markWeekly(key, {
          key,
          campaign_id: campaignId,
          uid: r.uid,
          email: r.email,
          first_name: r.first_name || "",
          status: records[key]?.status === "sent" ? "sent" : "pending",
          queued_at: records[key]?.queued_at || new Date().toISOString(),
          error: result.error || "send_failed",
          kind,
        });
      } catch {
        /* ignore mark failure on send failure */
      }
    }
  }

  const remainingStore = await loadStore();
  const remaining = Object.values(remainingStore.weekly_emails || {}).filter(
    (r) => r.status === "pending" && r.email
  ).length;

  return {
    ok: true,
    mode: "resend",
    kind,
    campaign_id: campaignId,
    utc_day: utcDay,
    reason,
    recipients: recipients.length,
    sent,
    failed,
    skipped,
    remaining,
    errors: errors.slice(0, 8),
    drain: { sent, failed, remaining, batch: sent + failed },
  };
}

async function unsubscribeEmail(email, token, { confirmOnly = false } = {}) {
  const clean = String(email || "").trim().toLowerCase();
  if (!clean.includes("@")) {
    const err = new Error("Invalid email");
    err.status = 422;
    throw err;
  }
  // Signed token from email links, OR explicit confirm (tokenless / broken links).
  if (!confirmOnly && !verifyUnsubToken(clean, token)) {
    const err = new Error("Invalid unsubscribe token");
    err.status = 401;
    throw err;
  }
  if (confirmOnly && token && !verifyUnsubToken(clean, token)) {
    // If a token was supplied with confirm, still require it to be valid.
    const err = new Error("Invalid unsubscribe token");
    err.status = 401;
    throw err;
  }
  await mutateStore((store) => {
    if (!store.weekly_unsubscribes) store.weekly_unsubscribes = {};
    store.weekly_unsubscribes[clean] = {
      email: clean,
      at: new Date().toISOString(),
      via: confirmOnly && !token ? "confirm" : "token",
    };
    // Cancel pending for this email
    for (const [key, rec] of Object.entries(store.weekly_emails || {})) {
      if (rec && String(rec.email || "").trim().toLowerCase() === clean && rec.status === "pending") {
        store.weekly_emails[key] = { ...rec, status: "unsubscribed" };
      }
    }
    return { ok: true };
  });
  return { ok: true, email: clean };
}

/**
 * For broken / tokenless links: email a fresh signed unsubscribe URL.
 * Always returns ok (don't leak whether the address exists) when email looks valid.
 */
async function sendUnsubscribeLink(email) {
  const clean = String(email || "").trim().toLowerCase();
  if (!clean.includes("@")) {
    const err = new Error("Invalid email");
    err.status = 422;
    throw err;
  }
  const { sendViaResend } = require("./mail");
  const link = unsubUrlFor(clean);
  const apiLink = unsubApiUrlFor(clean);
  const subject = "Confirm unsubscribe — SuperCompress";
  const text = `Click to unsubscribe from SuperCompress weekly emails:

${link}

If you didn't request this, you can ignore this message.

— Arjun
`;
  const html = `<p style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;">Click to unsubscribe from SuperCompress weekly emails:</p>
<p><a href="${link.replace(/"/g, "&quot;")}" style="color:#1d4ed8;">Unsubscribe</a></p>
<p style="color:#5c5a55;font-size:13px;">If you didn't request this, ignore this message.</p>`;
  const result = await sendViaResend({
    to: clean,
    subject,
    text,
    html,
    unsubUrl: link,
    listUnsubscribeUrl: apiLink,
  });
  return {
    ok: true,
    emailed: Boolean(result.ok),
    email: clean,
    error: result.ok ? null : result.error || "email_send_failed",
  };
}

module.exports = {
  drainSecretOk,
  isoWeekCampaignId,
  tipCampaignId,
  shipCampaignId,
  resolveCampaign,
  unsubToken,
  unsubUrlFor,
  unsubApiUrlFor,
  verifyUnsubToken,
  isUnsubscribed,
  enqueueWeeklyCampaign,
  listPendingWeekly,
  drainPendingWeekly,
  weeklyTick,
  unsubscribeEmail,
  sendUnsubscribeLink,
  markWeekly,
  BATCH_SIZE,
};
