/**
 * Once-ever power-user email when usage newly crosses 1M tokens.
 * Never backfills people already over the threshold.
 */

const { mutateStore } = require("./store");
const { sendPowerUserEmail } = require("./mail");

const POWER_USER_TOKENS = 1_000_000;

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

function statsFromUsage({ tokensIn, tokensSaved, requests } = {}) {
  const tin = Math.max(0, Number(tokensIn) || 0);
  const saved = Math.max(0, Number(tokensSaved) || 0);
  const reqs = Math.max(0, Number(requests) || 0);
  const cutPct = tin > 0 ? Math.round((saved / tin) * 100) : 0;
  const denom = Math.max(1, tin - saved);
  const morePct = tin > saved ? Math.round((tin / denom - 1) * 100) : 0;
  return { tokensIn: tin, tokensSaved: saved, requests: reqs, cutPct, morePct };
}

async function claimPowerUser(uid, extra = {}) {
  if (!uid) return { claimed: false, record: null, reason: "no_uid" };
  return mutateStore((store) => {
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
      idempotency_key: existing?.idempotency_key || `power-user-${uid}`,
      ...extra,
    };
    store.power_user_emails[uid] = record;
    return { claimed: true, record };
  });
}

async function markPowerUser(uid, patch) {
  return mutateStore((store) => {
    if (!store.power_user_emails) store.power_user_emails = {};
    const prev = store.power_user_emails[uid] || { uid };
    store.power_user_emails[uid] = { ...prev, ...patch };
    return store.power_user_emails[uid];
  });
}

function isDrainablePowerUser(rec) {
  if (!rec || !rec.uid) return false;
  if (rec.status !== "pending" && rec.status !== "failed" && rec.status !== "sending") {
    return false;
  }
  return String(rec.email || "").includes("@");
}

async function deliverPowerUser(rec) {
  const uid = rec.uid;
  const idempotencyKey = rec.idempotency_key || `power-user-${uid}`;
  // Mark sending before Resend so a crash after delivery does not look "pending"
  // for a fresh send — drain retries with the same Idempotency-Key.
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

/**
 * Retry pending/failed/sending crossing emails. Never creates records — so people
 * already over 1M with no row stay unmailed.
 */
async function drainPendingPowerUsers() {
  const { loadStore } = require("./store");
  const store = await loadStore();
  const pending = Object.values(store.power_user_emails || {}).filter(isDrainablePowerUser);

  let sent = 0;
  let failed = 0;
  for (const rec of pending) {
    const result = await deliverPowerUser(rec);
    if (result.ok) sent += 1;
    else failed += 1;
  }
  return { pending: pending.length, sent, failed };
}

/**
 * Send the branded power-user email only on a true 1M crossing (or a failed
 * prior send for that same crossing). People already over 1M with no record
 * are left alone — no backfill.
 */
async function maybeNotifyPowerUser({
  uid,
  email,
  displayName,
  prevTokens,
  nextTokens,
  tokensSaved,
  requests,
  source = "compress",
} = {}) {
  if (!uid) return { ok: true, sent: false, reason: "no_uid" };
  if (!crossedPowerUser(prevTokens, nextTokens)) {
    return { ok: true, sent: false, reason: "not_crossed" };
  }

  const to = String(email || "").trim();
  const firstName = firstNameFromUser({ displayName, email: to });
  const { claimed, record, reason } = await claimPowerUser(uid, {
    email: to,
    first_name: firstName,
    tokens_in: Number(nextTokens) || 0,
    tokens_saved: Number(tokensSaved) || 0,
    requests: Number(requests) || 0,
    source,
  });
  if (!claimed) {
    // If a prior attempt died while "sending", drain will finish with same
    // Idempotency-Key. Do not start a second claim here.
    return { ok: true, sent: false, reason: reason || "already_claimed", record };
  }

  if (!to.includes("@")) {
    await markPowerUser(uid, {
      status: "skipped_no_email",
      skipped_at: new Date().toISOString(),
    });
    return { ok: true, sent: false, reason: "no_email" };
  }

  const result = await deliverPowerUser({
    ...record,
    email: to,
    first_name: firstName,
    tokens_in: Number(nextTokens) || 0,
    tokens_saved: Number(tokensSaved) || 0,
    requests: Number(requests) || 0,
  });

  if (result.ok) return { ok: true, sent: true };
  return { ok: false, sent: false, queued: true, reason: result.error || "send_failed" };
}

function schedulePowerUserEmail(opts) {
  void maybeNotifyPowerUser(opts).catch((err) => {
    console.warn("power-user email skipped:", err.message || err);
  });
}

module.exports = {
  POWER_USER_TOKENS,
  crossedPowerUser,
  statsFromUsage,
  firstNameFromUser,
  isDrainablePowerUser,
  claimPowerUser,
  markPowerUser,
  maybeNotifyPowerUser,
  drainPendingPowerUsers,
  schedulePowerUserEmail,
};
