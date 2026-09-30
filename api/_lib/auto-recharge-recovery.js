/**
 * Revenue guard for auto-recharge: when off-session charge cannot complete
 * (India RBI mandate, 3DS, declined card, missing PM), open on-session Checkout
 * and email the customer (deduped per recharge cycle) so money is not left on
 * the table as orphan PaymentIntents.
 */

const SITE = "https://www.supercompress.dev";
const FOUNDER_ALERT_TO = "arjunkshah21@gmail.com";

function recoveryStoreKey(uid, cycle) {
  return `${String(uid || "").trim()}:c${Number(cycle) || 0}`;
}

function recoveryIdempotencyKey(uid, cycle) {
  return `auto-recharge-recovery-${String(uid || "").trim()}-c${Number(cycle) || 0}`.slice(0, 256);
}

async function claimRecoveryEmail(uid, cycle, extra = {}) {
  if (!uid) return { claimed: false, record: null, reason: "no_uid" };
  const key = recoveryStoreKey(uid, cycle);
  try {
    const { mutateStore } = require("./store");
    return await mutateStore((store) => {
      if (!store.auto_recharge_recovery_emails) store.auto_recharge_recovery_emails = {};
      const existing = store.auto_recharge_recovery_emails[key];
      if (existing && existing.status && existing.status !== "failed") {
        return { claimed: false, record: existing, reason: existing.status };
      }
      const record = {
        ...(existing || {}),
        key,
        uid,
        cycle: Number(cycle) || 0,
        status: "pending",
        claimed_at: existing?.claimed_at || new Date().toISOString(),
        idempotency_key: existing?.idempotency_key || recoveryIdempotencyKey(uid, cycle),
        ...extra,
      };
      store.auto_recharge_recovery_emails[key] = record;
      return { claimed: true, record };
    });
  } catch (err) {
    return {
      claimed: true,
      record: {
        key,
        uid,
        cycle: Number(cycle) || 0,
        status: "pending",
        claimed_at: new Date().toISOString(),
        idempotency_key: recoveryIdempotencyKey(uid, cycle),
        store_error: err.message || "store_unavailable",
        ...extra,
      },
      reason: "store_fallback",
    };
  }
}

async function markRecoveryEmail(key, patch) {
  try {
    const { mutateStore } = require("./store");
    return await mutateStore((store) => {
      if (!store.auto_recharge_recovery_emails) store.auto_recharge_recovery_emails = {};
      const prev = store.auto_recharge_recovery_emails[key] || { key };
      store.auto_recharge_recovery_emails[key] = { ...prev, ...patch };
      return store.auto_recharge_recovery_emails[key];
    });
  } catch (err) {
    return { key, ...patch, store_error: err.message || "store_unavailable" };
  }
}

/** Branded copy — delegates to mail.js (logo / CTA / signature). */
function recoveryEmailCopy(opts) {
  const { autoRechargeRecoveryCopy } = require("./mail");
  return autoRechargeRecoveryCopy(opts);
}

/**
 * Reuse an open credit Checkout for this customer when possible (avoids URL spam).
 */
async function findOpenCreditCheckout(stripe, customerId, amountUsd) {
  if (!stripe || !customerId) return null;
  try {
    const list = await stripe.checkout.sessions.list({
      customer: customerId,
      status: "open",
      limit: 15,
    });
    const wantCents = Math.round(Number(amountUsd || 0) * 100);
    let any = null;
    for (const session of list.data || []) {
      const kind = String(session.metadata?.kind || "");
      if (!kind.startsWith("credit_")) continue;
      if (!session.url) continue;
      if (wantCents > 0 && Number(session.amount_total) === wantCents) return session;
      if (!any) any = session;
    }
    return any;
  } catch (err) {
    console.warn("findOpenCreditCheckout:", err.message || err);
    return null;
  }
}

async function createOrReuseRecoveryCheckout({
  stripe,
  customerId,
  userId,
  creditUsd,
  createCheckout,
}) {
  const existing = await findOpenCreditCheckout(stripe, customerId, creditUsd);
  if (existing?.url) {
    return {
      checkoutUrl: existing.url,
      sessionId: existing.id,
      amount: Number(existing.amount_total || 0) / 100,
      reused: true,
    };
  }
  const created = await createCheckout({ customerId, userId, creditUsd });
  return { ...created, reused: false };
}

/**
 * Fire-and-forget customer recovery email + founder alert (once per cycle).
 */
function scheduleAutoRechargeRecoveryNotify({
  uid,
  email,
  firstName,
  amount,
  checkoutUrl,
  reason,
  cycle,
  customerId,
}) {
  if (!uid || !checkoutUrl) return;
  setImmediate(async () => {
    try {
      const { claimed, record } = await claimRecoveryEmail(uid, cycle, {
        email: email || null,
        amount: Number(amount) || null,
        reason: String(reason || ""),
        checkout_url: checkoutUrl,
        customer_id: customerId || null,
      });
      if (!claimed) return;

      const { sendAutoRechargeRecoveryEmail, sendViaResend, brandedEmailHtml } = require("./mail");
      let customerOk = false;
      if (email && String(email).includes("@")) {
        const sent = await sendAutoRechargeRecoveryEmail({
          email: String(email).trim(),
          firstName,
          amount,
          checkoutUrl,
          reason,
          idempotencyKey: record.idempotency_key,
        });
        customerOk = Boolean(sent.ok);
        if (!sent.ok) {
          console.warn("auto-recharge recovery email failed:", sent.error);
          await markRecoveryEmail(record.key, {
            status: "failed",
            error: sent.error || "send_failed",
            failed_at: new Date().toISOString(),
          });
        } else {
          await markRecoveryEmail(record.key, {
            status: "sent",
            resend_id: sent.id || null,
            sent_at: new Date().toISOString(),
          });
        }
      } else {
        await markRecoveryEmail(record.key, {
          status: "skipped_no_email",
          skipped_at: new Date().toISOString(),
        });
      }

      // Founder alert — also branded so it isn't a bare <pre> blob in Gmail.
      try {
        const alertSubject = `[SC] Auto-recharge needs confirm · ${email || uid} · $${Number(amount || 0)}`;
        const alertBody = `
<p style="margin:0 0 12px;">Auto-recharge could not complete silently.</p>
<p style="margin:0 0 8px;font-size:14px;line-height:1.5;">
  <strong>uid:</strong> ${String(uid)}<br />
  <strong>email:</strong> ${String(email || "(none)")}<br />
  <strong>customer:</strong> ${String(customerId || "?")}<br />
  <strong>reason:</strong> ${String(reason || "")}<br />
  <strong>amount:</strong> $${Number(amount || 0)}<br />
  <strong>cycle:</strong> ${Number(cycle) || 0}<br />
  <strong>customer_emailed:</strong> ${customerOk}
</p>
<p style="margin:16px 0;"><a href="${String(checkoutUrl)}" style="display:inline-block;padding:12px 18px;background:#0566ff;color:#fff;border-radius:8px;text-decoration:none;font-weight:700;">Open Checkout</a></p>
`;
        await sendViaResend({
          to: FOUNDER_ALERT_TO,
          subject: alertSubject,
          text: `Auto-recharge could not complete silently.\n\nuid: ${uid}\nemail: ${email || "(none)"}\ncustomer: ${customerId || "?"}\nreason: ${reason}\namount: $${amount}\ncycle: ${cycle}\ncustomer_emailed: ${customerOk}\n\nCheckout:\n${checkoutUrl}\n`,
          html: brandedEmailHtml({
            preheader: "Auto-recharge needs customer confirm",
            title: alertSubject,
            bodyHtml: alertBody,
            kind: "billing",
          }),
          idempotencyKey: `founder-${record.idempotency_key}`.slice(0, 256),
        });
      } catch (err) {
        console.warn("founder auto-recharge alert failed:", err.message || err);
      }
    } catch (err) {
      console.warn("scheduleAutoRechargeRecoveryNotify:", err.message || err);
    }
  });
}

function needsCheckoutFallback(errOrStatus) {
  const msg = String(errOrStatus?.message || errOrStatus || "");
  const code = String(errOrStatus?.code || errOrStatus?.decline_code || "");
  const status = String(errOrStatus?.status || "");
  if (/india|mandate for off-session/i.test(msg) || code === "india_recurring_payment_mandate_required") {
    return true;
  }
  if (
    /authentication_required|requires_action|requires_confirmation|card_declined|insufficient_funds|expired_card|incorrect_cvc|payment_intent_authentication_failure|do_not_honor/i.test(
      `${msg} ${code} ${status}`
    )
  ) {
    return true;
  }
  if (["requires_action", "requires_confirmation", "requires_payment_method"].includes(status)) {
    return true;
  }
  return false;
}

module.exports = {
  findOpenCreditCheckout,
  createOrReuseRecoveryCheckout,
  scheduleAutoRechargeRecoveryNotify,
  needsCheckoutFallback,
  recoveryEmailCopy,
  recoveryStoreKey,
  FOUNDER_ALERT_TO,
  SITE,
};
