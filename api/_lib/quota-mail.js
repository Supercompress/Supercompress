/**
 * Once-per-month quota-exhausted email when a free-tier user hits the 5M cap
 * and compression starts returning 402. Durable on Auth claims
 * (`sc_quota_mail` = "YYYY-MM") + store queue + Resend Idempotency-Key, same
 * pattern as the power-user lane so it survives store outages.
 */

const QUOTA_MAIL_CLAIM = "sc_quota_mail";

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function quotaIdempotencyKey(uid, month) {
  return `quota-exhausted-${String(uid || "").trim()}-${String(month || "").trim()}`;
}

function quotaMailAlreadySent(claims = {}, month = currentMonth()) {
  return String(claims?.[QUOTA_MAIL_CLAIM] || "") === String(month);
}

async function claimQuotaMail(uid, month, extra = {}) {
  if (!uid) return { claimed: false, record: null, reason: "no_uid" };
  const key = `${month}:${uid}`;
  try {
    const { mutateStore } = require("./store");
    return await mutateStore((store) => {
      if (!store.quota_emails) store.quota_emails = {};
      const existing = store.quota_emails[key];
      if (existing && existing.status && existing.status !== "failed") {
        return { claimed: false, record: existing, reason: existing.status };
      }
      const record = {
        ...(existing || {}),
        key,
        uid,
        month,
        status: "pending",
        claimed_at: existing?.claimed_at || new Date().toISOString(),
        retried_at: existing ? new Date().toISOString() : null,
        idempotency_key:
          existing?.idempotency_key || quotaIdempotencyKey(uid, month),
        ...extra,
      };
      store.quota_emails[key] = record;
      return { claimed: true, record };
    });
  } catch (err) {
    const record = {
      key,
      uid,
      month,
      status: "pending",
      claimed_at: new Date().toISOString(),
      idempotency_key: quotaIdempotencyKey(uid, month),
      store_error: err.message || "store_unavailable",
      ...extra,
    };
    return { claimed: true, record, reason: "claims_fallback" };
  }
}

async function markQuotaMail(key, patch) {
  try {
    const { mutateStore } = require("./store");
    return await mutateStore((store) => {
      if (!store.quota_emails) store.quota_emails = {};
      const prev = store.quota_emails[key] || { key };
      store.quota_emails[key] = { ...prev, ...patch };
      return store.quota_emails[key];
    });
  } catch (err) {
    return { key, ...patch, store_error: err.message || "store_unavailable" };
  }
}

async function stampQuotaMailSent(uid, month) {
  if (!uid) return false;
  const { initFirebaseAdmin } = require("./auth");
  if (!initFirebaseAdmin()) return false;
  const { stampOwnerClaim } = require("./billing-ledger");
  return stampOwnerClaim(uid, QUOTA_MAIL_CLAIM, String(month));
}

function isDrainableQuotaMail(rec, month = currentMonth()) {
  if (!rec || !rec.uid) return false;
  // Never send a stale "you're paused" email for a previous month.
  if (String(rec.month || "") !== String(month)) return false;
  if (
    rec.status !== "pending" &&
    rec.status !== "failed" &&
    rec.status !== "sending"
  ) {
    return false;
  }
  return String(rec.email || "").includes("@");
}

async function deliverQuotaMail(rec) {
  const { sendQuotaExhaustedEmail } = require("./mail");
  const key = rec.key || `${rec.month}:${rec.uid}`;
  const idempotencyKey =
    rec.idempotency_key || quotaIdempotencyKey(rec.uid, rec.month);
  await markQuotaMail(key, {
    status: "sending",
    send_attempt_at: new Date().toISOString(),
    idempotency_key: idempotencyKey,
  });

  const result = await sendQuotaExhaustedEmail({
    email: rec.email,
    firstName: rec.first_name || "",
    tokensUsed: rec.tokens_used,
    freeTokens: rec.free_tokens,
    month: rec.month,
    idempotencyKey,
  });

  if (result.ok) {
    try {
      await stampQuotaMailSent(rec.uid, rec.month);
    } catch (err) {
      console.warn("quota mail claim stamp failed:", err.message || err);
    }
    await markQuotaMail(key, {
      status: "sent",
      sent_at: new Date().toISOString(),
      provider: result.provider || "resend",
      provider_id: result.id || null,
      error: null,
    });
    return { ok: true };
  }

  await markQuotaMail(key, {
    status: "pending",
    error: result.error || "send_failed",
    failed_at: new Date().toISOString(),
  });
  return { ok: false, error: result.error || "send_failed" };
}

/**
 * Fire when a free-tier compress request 402s. Sends at most once per
 * (uid, month); safe to call on every paywalled request.
 */
async function maybeNotifyQuotaExhausted({
  uid,
  email,
  displayName,
  tokensUsed,
  freeTokens,
  claims = null,
} = {}) {
  if (!uid) return { ok: true, sent: false, reason: "no_uid" };
  const month = currentMonth();

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

  if (quotaMailAlreadySent(live, month)) {
    return { ok: true, sent: false, reason: "already_sent" };
  }

  const { firstNameFromUser } = require("./power-user");
  const extra = {
    email: to,
    first_name: firstNameFromUser({ displayName: name, email: to }),
    tokens_used: Number(tokensUsed) || 0,
    free_tokens: Number(freeTokens) || 0,
  };
  const { claimed, record } = await claimQuotaMail(uid, month, extra);
  if (!claimed) {
    return {
      ok: true,
      sent: false,
      reason: record?.status || "already_claimed",
    };
  }

  if (!to.includes("@")) {
    await markQuotaMail(record.key, {
      status: "skipped_no_email",
      skipped_at: new Date().toISOString(),
    });
    return { ok: true, sent: false, reason: "no_email" };
  }

  const result = await deliverQuotaMail({ ...record, ...extra });
  if (result.ok) return { ok: true, sent: true };
  return {
    ok: false,
    sent: false,
    queued: true,
    reason: result.error || "send_failed",
  };
}

const DRAIN_AUTH_CAP = 80;

function isStubUid(uid) {
  return /^(sck_|sc_at_|sc_ac_|sc_aff_|sc_lnk_)/.test(String(uid || ""));
}

/**
 * Mail every free-tier human already at/over the monthly free cap who has not
 * received this month's quota email. Conversion lane — run from cron + welcome-drain.
 */
async function drainAuthQuotaMails({ cap = DRAIN_AUTH_CAP } = {}) {
  const { initFirebaseAdmin } = require("./auth");
  const admin = require("firebase-admin");
  const { freeAllowance, isPaygEnabled, isComped, isLegacyMetered, isCreditWallet } =
    require("./stripe");
  if (!initFirebaseAdmin()) return { scanned: 0, mailed: 0, skipped: 0, error: "no_admin" };

  const month = currentMonth();
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
      if (isComped(claims) || isLegacyMetered(claims)) {
        skipped += 1;
        continue;
      }
      if (isPaygEnabled(claims.sc_plan) || isCreditWallet(claims)) {
        skipped += 1;
        continue;
      }
      if (quotaMailAlreadySent(claims, month)) {
        skipped += 1;
        continue;
      }
      const usage = claims.sc_usage || {};
      const tin =
        String(usage.month || "") === month
          ? Number(usage.tokens_in || 0) || 0
          : 0;
      const freeCap = freeAllowance(claims);
      // Aggressive conversion: email once they burn ≥98% of free (or are over).
      // Sitting at 4.999M without a mail was leaking cash — they feel the wall
      // on the next request but never got the unlock CTA.
      const wallThreshold = Math.max(0, Math.floor(freeCap * 0.98));
      if (tin < wallThreshold) continue;
      scanned += 1;
      const result = await maybeNotifyQuotaExhausted({
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || "",
        tokensUsed: tin,
        freeTokens: freeCap,
        claims,
      });
      if (result.sent) mailed += 1;
      else skipped += 1;
    }
    pageToken = mailed >= cap ? null : page.pageToken;
  } while (pageToken);

  return { scanned, mailed, skipped, month };
}

/** Retry store-queued quota mails, then Auth-scan free users at the wall. */
async function drainPendingQuotaMails() {
  const month = currentMonth();
  let pending = 0;
  let sent = 0;
  let failed = 0;
  let storeError = null;
  try {
    const { loadStore } = require("./store");
    const store = await loadStore();
    const records = Object.values(store.quota_emails || {}).filter((r) =>
      isDrainableQuotaMail(r, month),
    );
    pending = records.length;
    for (const rec of records) {
      const result = await deliverQuotaMail(rec);
      if (result.ok) sent += 1;
      else failed += 1;
    }
  } catch (err) {
    storeError = err.message || "store_unavailable";
  }

  const authDrain = await drainAuthQuotaMails();
  return {
    pending,
    sent,
    failed,
    store_error: storeError,
    auth: authDrain,
  };
}

function scheduleQuotaExhaustedEmail(opts) {
  void maybeNotifyQuotaExhausted(opts).catch((err) => {
    console.warn("quota-exhausted email skipped:", err.message || err);
  });
}

module.exports = {
  QUOTA_MAIL_CLAIM,
  quotaIdempotencyKey,
  quotaMailAlreadySent,
  isDrainableQuotaMail,
  claimQuotaMail,
  markQuotaMail,
  maybeNotifyQuotaExhausted,
  drainPendingQuotaMails,
  drainAuthQuotaMails,
  scheduleQuotaExhaustedEmail,
  stampQuotaMailSent,
};
