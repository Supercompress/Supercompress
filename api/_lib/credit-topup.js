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
const { mutateStore } = require("./store");
const { initFirebaseAdmin } = require("./auth");
const admin = require("firebase-admin");

/** Thank-you grant on first successful credit top-up (1M tokens @ current PAYG rate). */
const FIRST_PAY_BONUS_TOKENS = TOKENS_PER_BILLING_UNIT;
const FIRST_PAY_BONUS_USD = tokensToUsd(FIRST_PAY_BONUS_TOKENS);

async function updateBillingClaims(userId, data) {
  if (!userId || !initFirebaseAdmin()) return;
  const user = await admin.auth().getUser(userId);
  const prev = user.customClaims || {};
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
  await admin.auth().setCustomUserClaims(userId, next);
  return next;
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
  if (session.payment_status && session.payment_status !== "paid") {
    return { applied: false, reason: "not_paid" };
  }

  if (!initFirebaseAdmin()) return { applied: false, reason: "firebase_unavailable" };
  const user = await admin.auth().getUser(userId);
  const prev = user.customClaims || {};
  const credited = Array.isArray(prev.sc_credited_sessions)
    ? prev.sc_credited_sessions
    : [];
  if (credited.includes(session.id)) {
    console.log("Credit top-up already applied:", session.id);
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

  const creditUsd = normalizeCreditLimitUsd(
    session.metadata?.credit_usd || (session.amount_total != null ? session.amount_total / 100 : null),
    DEFAULT_CREDIT_LIMIT_USD
  );
  const autoRecharge =
    session.metadata?.auto_recharge === "true"
      ? true
      : session.metadata?.auto_recharge === "false"
        ? false
        : Boolean(prev.sc_auto_recharge);

  let paymentMethod = prev.sc_default_payment_method || null;
  try {
    const stripe = getStripe();
    if (session.payment_intent) {
      const pi = await stripe.paymentIntents.retrieve(String(session.payment_intent));
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

  const grantFirstPayBonus = !prev.sc_first_pay_bonus_at;
  const bonusUsd = grantFirstPayBonus ? FIRST_PAY_BONUS_USD : 0;
  const limitUsd = normalizeCreditLimitUsd(
    session.metadata?.credit_usd || prev.sc_credit_limit_usd,
    creditUsd
  );

  // Ledger first (idempotent by session.id) — Auth claims mirror from ledger.
  const { creditBalance } = require("./billing-ledger");
  const ledgerResult = await creditBalance({
    uid: userId,
    creditUsd: creditUsd + bonusUsd,
    creditKey: session.id,
    claims: prev,
    patch: {
      credit_limit_usd: limitUsd,
      auto_recharge: autoRecharge,
      customer_id: session.customer,
    },
  });
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
  if (grantFirstPayBonus) {
    persistPayload.sc_first_pay_bonus_at = new Date().toISOString();
    persistPayload.sc_first_pay_bonus_usd = bonusUsd;
  }

  await persistSubscription(userId, persistPayload);

  console.log(
    `Credited $${creditUsd}${bonusUsd ? ` + $${bonusUsd} first-pay bonus` : ""} to ${userId}; balance=$${newBalance}`
  );
  return {
    applied: true,
    already: false,
    balance: newBalance,
    creditUsd,
    firstPayBonusUsd: bonusUsd,
    firstPayBonusTokens: grantFirstPayBonus ? FIRST_PAY_BONUS_TOKENS : 0,
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

module.exports = {
  applyCreditTopUp,
  persistSubscription,
  updateBillingClaims,
  reconcileCreditCheckout,
  FIRST_PAY_BONUS_TOKENS,
  FIRST_PAY_BONUS_USD,
};
