/**
 * Apply prepaid credit from a completed Stripe Checkout session (or synthetic PI session).
 * Idempotent via session.id in Firebase custom claims sc_credited_sessions.
 */
const {
  getStripe,
  normalizeCreditLimitUsd,
  DEFAULT_CREDIT_LIMIT_USD,
  roundUsd,
  tokensToUsd,
  TOKENS_PER_BILLING_UNIT,
} = require("./stripe");
const {
  paidCreditUsdFromSession,
  isCreditablePaidUsd,
} = require("./credit-amount");
const { mutateStore } = require("./store");
const { initFirebaseAdmin } = require("./auth");
const admin = require("firebase-admin");

/** Thank-you grant on first successful credit top-up (1M tokens @ current PAYG rate). */
const FIRST_PAY_BONUS_TOKENS = TOKENS_PER_BILLING_UNIT;
const FIRST_PAY_BONUS_USD = tokensToUsd(FIRST_PAY_BONUS_TOKENS);

function stripeAlreadyCredited(session) {
  const meta = session?.metadata || {};
  return meta.sc_credited === "true" || meta.sc_credited === true;
}

/**
 * Durable idempotency beyond the sliding sc_credited_sessions window:
 * stamp the Checkout session / PaymentIntent so reconcile cannot re-mint credits
 * after old session ids age out of Auth claims.
 */
async function markStripeCredited(session) {
  if (!session?.id || stripeAlreadyCredited(session)) return;
  try {
    const stripe = getStripe();
    const stamp = {
      sc_credited: "true",
      sc_credited_at: new Date().toISOString().slice(0, 19) + "Z",
    };
    const id = String(session.id);
    if (id.startsWith("cs_")) {
      await stripe.checkout.sessions.update(id, {
        metadata: { ...(session.metadata || {}), ...stamp },
      });
      return;
    }
    // Synthetic PI sessions use id `pi_<PaymentIntentId>` or bare PI id.
    const piId = id.startsWith("pi_pi_")
      ? id.slice(3)
      : id.startsWith("pi_")
        ? id
        : session.payment_intent
          ? String(session.payment_intent)
          : null;
    if (piId) {
      const pi = await stripe.paymentIntents.retrieve(piId);
      await stripe.paymentIntents.update(piId, {
        metadata: { ...(pi.metadata || {}), ...stamp },
      });
    }
  } catch (err) {
    console.warn("Could not stamp Stripe sc_credited:", err.message || err);
  }
}

async function updateBillingClaims(userId, data) {
  if (!userId || !initFirebaseAdmin()) return;
  const { patchUserClaims } = require("./billing-ledger");
  return patchUserClaims(userId, (prev) => {
    const next = {
      ...prev,
      sc_plan: data.plan_id || prev.sc_plan || "free",
      sc_subscription_status: data.status || "active",
      sc_customer_id: data.stripe_customer_id || prev.sc_customer_id || null,
    };
    if (data.stripe_subscription_id !== undefined) {
      next.sc_subscription_id = data.stripe_subscription_id;
    }
    if (data.sc_metered != null) next.sc_metered = data.sc_metered;
    if (data.sc_credit_balance_usd != null) next.sc_credit_balance_usd = data.sc_credit_balance_usd;
    if (data.sc_credit_limit_usd != null) next.sc_credit_limit_usd = data.sc_credit_limit_usd;
    if (data.sc_auto_recharge != null) next.sc_auto_recharge = data.sc_auto_recharge;
    if (data.sc_default_payment_method) {
      next.sc_default_payment_method = data.sc_default_payment_method;
    }
    if (data.sc_credited_sessions) next.sc_credited_sessions = data.sc_credited_sessions;
    if (data.sc_first_pay_bonus_at) next.sc_first_pay_bonus_at = data.sc_first_pay_bonus_at;
    if (data.sc_first_pay_bonus_usd != null) next.sc_first_pay_bonus_usd = data.sc_first_pay_bonus_usd;
    return next;
  });
}

async function persistSubscription(userId, data) {
  const nextClaims = await updateBillingClaims(userId, data);
  const storePatch = {
    stripe_customer_id: data.stripe_customer_id,
    stripe_subscription_id: data.stripe_subscription_id,
    plan_id: data.plan_id,
    status: data.status,
    cancel_at_period_end: data.cancel_at_period_end,
    current_period_start: data.current_period_start,
    current_period_end: data.current_period_end,
    credit_balance_usd: data.sc_credit_balance_usd ?? data.credit_balance_usd,
    credit_limit_usd: data.sc_credit_limit_usd ?? data.credit_limit_usd,
    auto_recharge: data.sc_auto_recharge ?? data.auto_recharge,
    updated_at: data.updated_at || new Date().toISOString(),
  };
  for (const k of Object.keys(storePatch)) {
    if (storePatch[k] === undefined) delete storePatch[k];
  }
  try {
    await mutateStore((s) => {
      if (!s.subscriptions) s.subscriptions = {};
      s.subscriptions[userId] = { ...(s.subscriptions[userId] || {}), ...storePatch };
      return true;
    });
  } catch (err) {
    if (err.status !== 503) throw err;
    console.warn("Subscription saved to Firebase; Blob mirror unavailable:", err.message);
  }
  return nextClaims;
}

/**
 * Credit prepaid balance from a completed Checkout payment (idempotent by session id).
 * @returns {{ applied: boolean, balance?: number, creditUsd?: number, already?: boolean }}
 */
async function applyCreditTopUp(session) {
  const userId = session.metadata?.user_id;
  const kind = session.metadata?.kind || "";
  if (!userId || !kind.startsWith("credit_")) {
    return { applied: false, reason: "not_credit_session" };
  }
  // Require an explicit paid signal when present. Synthetic PI sessions set payment_status.
  if (session.payment_status && session.payment_status !== "paid") {
    return { applied: false, reason: "not_paid" };
  }
  // Never credit "complete but unpaid" async Checkout (e.g. bank debits still pending).
  if (session.status === "complete" && session.payment_status && session.payment_status !== "paid") {
    return { applied: false, reason: "not_paid" };
  }

  if (stripeAlreadyCredited(session)) {
    if (!initFirebaseAdmin()) {
      return { applied: true, already: true, balance: 0, creditUsd: 0 };
    }
    const u = await admin.auth().getUser(userId);
    const prev = u.customClaims || {};
    return {
      applied: true,
      already: true,
      balance: roundUsd(Number(prev.sc_credit_balance_usd || 0)),
      creditUsd: 0,
      firstPayBonusUsd: 0,
      firstPayBonusTokens: 0,
    };
  }

  // Dollars credited = what Stripe charged, never metadata.credit_usd (promo / mismatch / spoof).
  const creditUsd = paidCreditUsdFromSession(session);
  if (!isCreditablePaidUsd(creditUsd)) {
    return { applied: false, reason: "invalid_paid_amount", creditUsd };
  }

  if (!initFirebaseAdmin()) return { applied: false, reason: "firebase_unavailable" };
  const user = await admin.auth().getUser(userId);
  const prev = user.customClaims || {};
  const credited = Array.isArray(prev.sc_credited_sessions)
    ? prev.sc_credited_sessions
    : [];
  if (credited.includes(session.id)) {
    console.log("Credit top-up already applied:", session.id);
    await markStripeCredited(session);
    const alreadyBonus = prev.sc_first_pay_bonus_at
      ? Number(prev.sc_first_pay_bonus_usd || FIRST_PAY_BONUS_USD)
      : 0;
    return {
      applied: true,
      already: true,
      balance: roundUsd(Number(prev.sc_credit_balance_usd || 0)),
      creditUsd: 0,
      firstPayBonusUsd: alreadyBonus,
      firstPayBonusTokens: alreadyBonus > 0 ? FIRST_PAY_BONUS_TOKENS : 0,
    };
  }

  // Default ON for new purchases; only an explicit "false" in Checkout metadata opts out.
  const autoRecharge = session.metadata?.auto_recharge !== "false";

  let paymentMethod = prev.sc_default_payment_method || null;
  try {
    const stripe = getStripe();
    if (session.payment_intent) {
      const pi = await stripe.paymentIntents.retrieve(String(session.payment_intent));
      if (pi.metadata?.sc_credited === "true") {
        await markStripeCredited(session);
        return {
          applied: true,
          already: true,
          balance: roundUsd(Number(prev.sc_credit_balance_usd || 0)),
          creditUsd: 0,
          firstPayBonusUsd: 0,
          firstPayBonusTokens: 0,
        };
      }
      paymentMethod = pi.payment_method || paymentMethod;
      if (paymentMethod && session.customer) {
        await stripe.customers.update(session.customer, {
          invoice_settings: { default_payment_method: String(paymentMethod) },
        });
      }
    }
  } catch (err) {
    console.warn("Could not attach default PM:", err.message || err);
  }

  const grantFirstPayBonusUsd = FIRST_PAY_BONUS_USD;
  // Recharge threshold stays a pack size (min $10), independent of this payment's amount.
  const limitUsd = normalizeCreditLimitUsd(
    prev.sc_credit_limit_usd || session.metadata?.credit_usd,
    Math.max(DEFAULT_CREDIT_LIMIT_USD, creditUsd)
  );

  // Ledger first (idempotent by session.id). First-pay bonus is create-once in txn.
  const { creditBalance } = require("./billing-ledger");
  const ledgerResult = await creditBalance({
    uid: userId,
    creditUsd,
    creditKey: session.id,
    claims: prev,
    patch: {
      credit_limit_usd: limitUsd,
      auto_recharge: autoRecharge,
      customer_id: session.customer,
    },
    firstPayBonusUsd: grantFirstPayBonusUsd,
  });

  if (ledgerResult.already) {
    console.log("Credit top-up already applied (ledger):", session.id);
    await markStripeCredited(session);
    return {
      applied: true,
      already: true,
      balance: roundUsd(
        ledgerResult.balance != null
          ? ledgerResult.balance
          : Number(prev.sc_credit_balance_usd || 0)
      ),
      creditUsd: 0,
      firstPayBonusUsd: 0,
      firstPayBonusTokens: 0,
    };
  }

  const bonusUsd = Number(ledgerResult.bonus_usd || 0);
  const newBalance = roundUsd(
    ledgerResult.balance != null
      ? ledgerResult.balance
      : Number(prev.sc_credit_balance_usd || 0) + creditUsd + bonusUsd
  );
  const nextCredited = Array.isArray(ledgerResult.ledger?.credited_keys)
    ? ledgerResult.ledger.credited_keys
    : [...credited.slice(-40), session.id];

  const persistPayload = {
    stripe_customer_id: session.customer,
    stripe_subscription_id: prev.sc_subscription_id || null,
    plan_id: "payg",
    status: "active",
    sc_metered: false,
    sc_credit_balance_usd: newBalance,
    sc_credit_limit_usd: limitUsd,
    sc_auto_recharge: autoRecharge,
    sc_default_payment_method: paymentMethod ? String(paymentMethod) : undefined,
    sc_credited_sessions: nextCredited,
    credit_balance_usd: newBalance,
    credit_limit_usd: limitUsd,
    auto_recharge: autoRecharge,
    updated_at: new Date().toISOString(),
  };
  if (bonusUsd > 0) {
    persistPayload.sc_first_pay_bonus_at = new Date().toISOString();
    persistPayload.sc_first_pay_bonus_usd = bonusUsd;
  }

  await persistSubscription(userId, persistPayload);
  await markStripeCredited(session);

  console.log(
    `Credited $${creditUsd}${bonusUsd ? ` + $${bonusUsd} first-pay bonus` : ""} to ${userId}; balance=$${newBalance}`
  );
  return {
    applied: true,
    already: false,
    balance: newBalance,
    creditUsd,
    firstPayBonusUsd: bonusUsd,
    firstPayBonusTokens: bonusUsd > 0 ? FIRST_PAY_BONUS_TOKENS : 0,
  };
}

/**
 * Authenticated reconcile: apply a paid Checkout session belonging to this user.
 * Also used as a webhook fallback when Stripe delivery fails.
 */
async function reconcileCreditCheckout({ userId, sessionId }) {
  if (!userId || !sessionId) {
    return { ok: false, detail: "userId and sessionId required" };
  }
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.metadata?.user_id && session.metadata.user_id !== userId) {
    return { ok: false, detail: "Checkout session does not belong to this user" };
  }
  if (session.customer) {
    const customer = await stripe.customers.retrieve(String(session.customer));
    const custUid = customer.metadata?.user_id;
    if (custUid && custUid !== userId) {
      return { ok: false, detail: "Checkout customer does not belong to this user" };
    }
  }
  const result = await applyCreditTopUp(session);
  if (!result.applied && result.reason === "not_credit_session") {
    return { ok: false, detail: "Not a credit checkout session", result };
  }
  if (!result.applied && result.reason === "not_paid") {
    return { ok: false, detail: "Payment not completed", result };
  }
  return {
    ok: true,
    credit_balance_usd: result.balance,
    credited_usd: result.creditUsd,
    first_pay_bonus_usd: result.firstPayBonusUsd || 0,
    first_pay_bonus_tokens: result.firstPayBonusTokens || 0,
    already: Boolean(result.already),
  };
}

/**
 * Self-heal: find recent paid credit Checkout sessions for this user that never
 * landed in sc_credited_sessions, and apply them. Covers webhook drops + Firestore
 * outages without requiring the customer to paste a session_id.
 *
 * Bounded lookback (default 14 sessions / ~30d of Stripe list pages) so billing GET
 * stays cheap.
 */
async function reconcileOutstandingCreditCheckouts({
  userId,
  customerId = null,
  claims = null,
  limit = 14,
} = {}) {
  if (!userId || !initFirebaseAdmin()) {
    return { ok: false, applied: 0, credited_usd: 0, detail: "unavailable" };
  }
  const stripe = getStripe();
  let custId = customerId;
  if (!custId) {
    const matches = await stripe.customers.search({
      query: `metadata['user_id']:'${String(userId).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`,
      limit: 1,
    });
    custId = matches.data[0]?.id || null;
  }
  if (!custId) {
    return { ok: true, applied: 0, credited_usd: 0, sessions: [] };
  }

  const fresh = await admin.auth().getUser(userId);
  const liveClaims = claims || fresh.customClaims || {};
  const already = new Set(
    Array.isArray(liveClaims.sc_credited_sessions) ? liveClaims.sc_credited_sessions : []
  );

  const sessions = await stripe.checkout.sessions.list({
    customer: custId,
    limit: Math.max(1, Math.min(25, Number(limit) || 14)),
  });

  let applied = 0;
  let creditedUsd = 0;
  const results = [];
  for (const session of sessions.data) {
    const kind = session.metadata?.kind || "";
    if (!kind.startsWith("credit_")) continue;
    // Strict: only settle money that Stripe confirms paid (not async-pending "complete").
    if (session.payment_status !== "paid") continue;
    if (session.metadata?.user_id && session.metadata.user_id !== userId) continue;
    if (session.metadata?.sc_credited === "true") {
      already.add(session.id);
      continue;
    }
    if (already.has(session.id)) continue;
    try {
      const result = await applyCreditTopUp(session);
      if (result.applied && !result.already) {
        applied += 1;
        creditedUsd = roundUsd(creditedUsd + Number(result.creditUsd || 0) + Number(result.firstPayBonusUsd || 0));
      }
      already.add(session.id);
      results.push({
        id: session.id,
        applied: Boolean(result.applied),
        already: Boolean(result.already),
        creditUsd: result.creditUsd || 0,
        reason: result.reason,
      });
    } catch (err) {
      console.error("outstanding credit reconcile failed:", session.id, err?.message || err);
      results.push({ id: session.id, error: err?.message || String(err) });
    }
  }

  const after = await admin.auth().getUser(userId);
  return {
    ok: true,
    applied,
    credited_usd: creditedUsd,
    credit_balance_usd: roundUsd(Number(after.customClaims?.sc_credit_balance_usd || 0)),
    sessions: results,
  };
}

module.exports = {
  applyCreditTopUp,
  persistSubscription,
  updateBillingClaims,
  reconcileCreditCheckout,
  reconcileOutstandingCreditCheckouts,
  FIRST_PAY_BONUS_TOKENS,
  FIRST_PAY_BONUS_USD,
};
