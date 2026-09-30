/**
 * Founder thank-you email after a successful prepaid credit Checkout.
 *
 * Only intentional Checkout pays (credit_enable / credit_topup) — never
 * silent auto-recharge PIs. Deduped per Stripe session via Resend
 * Idempotency-Key + optional config-store record.
 *
 * Cutoff: payments whose Stripe created timestamp is before
 * PAYMENT_THANK_YOU_AFTER (default 2026-08-14T23:00:00Z) are skipped so the
 * first three live sales are not backfilled.
 */

const DEFAULT_AFTER_ISO = "2026-08-14T23:00:00.000Z";

function paymentThankYouAfterMs() {
  const raw = String(process.env.PAYMENT_THANK_YOU_AFTER || DEFAULT_AFTER_ISO).trim();
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : Date.parse(DEFAULT_AFTER_ISO);
}

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

function thankYouIdempotencyKey(paymentKey) {
  return `payment-thanks-${String(paymentKey || "").trim()}`.slice(0, 256);
}

function shouldSendPaymentThankYou({ kind, paymentCreatedSec, alreadyCredited }) {
  if (alreadyCredited) return false;
  const k = String(kind || "");
  // Checkout credit packs only — not silent off-session auto-recharge PIs.
  // India on-session Checkout (credit_auto_recharge_checkout) still gets a thank-you.
  if (k === "credit_auto_recharge") return false;
  if (!k.startsWith("credit_")) return false;
  if (paymentCreatedSec != null) {
    const createdMs = Number(paymentCreatedSec) * 1000;
    if (Number.isFinite(createdMs) && createdMs < paymentThankYouAfterMs()) {
      return false;
    }
  }
  return true;
}

async function markPaymentThankYou(paymentKey, patch) {
  if (!paymentKey) return null;
  try {
    const { mutateStore } = require("./store");
    return await mutateStore((store) => {
      if (!store.payment_thank_you_emails) store.payment_thank_you_emails = {};
      const prev = store.payment_thank_you_emails[paymentKey] || {};
      const next = { ...prev, ...patch, payment_key: paymentKey };
      store.payment_thank_you_emails[paymentKey] = next;
      return next;
    });
  } catch (err) {
    console.warn("payment thank-you store skip:", err.message || err);
    return { payment_key: paymentKey, ...patch };
  }
}

/**
 * Fire-and-forget after a successful credit top-up.
 * Safe to call on webhook retries — Resend + store dedupe by session id.
 */
function schedulePaymentThankYou({
  uid,
  email,
  firstName,
  creditUsd,
  autoRecharge,
  paymentKey,
  kind,
  paymentCreatedSec,
  alreadyCredited,
}) {
  if (
    !shouldSendPaymentThankYou({
      kind,
      paymentCreatedSec,
      alreadyCredited,
    })
  ) {
    return;
  }
  const key = String(paymentKey || "").trim();
  const to = String(email || "").trim();
  if (!key || !to.includes("@")) return;

  setImmediate(() => {
    void deliverPaymentThankYou({
      uid,
      email: to,
      firstName,
      creditUsd,
      autoRecharge,
      paymentKey: key,
      kind,
    }).catch((err) => {
      console.warn("payment thank-you failed:", err?.message || err);
    });
  });
}

async function deliverPaymentThankYou({
  uid,
  email,
  firstName,
  creditUsd,
  autoRecharge,
  paymentKey,
  kind,
}) {
  const { sendPaymentThankYouEmail } = require("./mail");
  const idempotencyKey = thankYouIdempotencyKey(paymentKey);

  try {
    const { loadStore } = require("./store");
    const store = await loadStore().catch(() => null);
    const existing = store?.payment_thank_you_emails?.[paymentKey];
    if (existing?.status === "sent") {
      return { ok: true, already: true };
    }
  } catch (_) {
    /* store optional */
  }

  await markPaymentThankYou(paymentKey, {
    uid: uid || null,
    email,
    first_name: firstName || "",
    kind: kind || null,
    credit_usd: Number(creditUsd) || 0,
    auto_recharge: Boolean(autoRecharge),
    status: "sending",
    idempotency_key: idempotencyKey,
    send_attempt_at: new Date().toISOString(),
  });

  const result = await sendPaymentThankYouEmail({
    email,
    firstName: firstName || "",
    creditUsd,
    autoRecharge,
    idempotencyKey,
  });

  if (!result.ok) {
    await markPaymentThankYou(paymentKey, {
      status: "failed",
      error: result.error || "send_failed",
      failed_at: new Date().toISOString(),
    });
    return result;
  }

  await markPaymentThankYou(paymentKey, {
    status: "sent",
    provider: result.provider || "resend",
    provider_id: result.id || null,
    sent_at: new Date().toISOString(),
    error: null,
  });
  return result;
}

module.exports = {
  DEFAULT_AFTER_ISO,
  paymentThankYouAfterMs,
  shouldSendPaymentThankYou,
  schedulePaymentThankYou,
  deliverPaymentThankYou,
  thankYouIdempotencyKey,
  firstNameFromUser,
};
