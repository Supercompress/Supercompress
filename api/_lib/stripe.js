/**
 * Stripe client — initialized once per warm lambda.
 * Requires STRIPE_SECRET_KEY env var.
 *
 * Pricing model:
 *   Free:  5M tokens / month
 *   PAYG:  prepaid credit wallet — $0.10 per 1M tokens after free allowance
 *          (legacy metered subscriptions still supported via sc_metered)
 */

let stripeClient = null;

function getStripe() {
  if (stripeClient) return stripeClient;

  const secretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!secretKey) {
    const err = new Error("Stripe not configured: missing STRIPE_SECRET_KEY");
    err.status = 503;
    throw err;
  }

  const Stripe = require("stripe");
  stripeClient = new Stripe(secretKey, {
    maxNetworkRetries: 2,
  });

  return stripeClient;
}

/** Read an env var, trimming surrounding whitespace/newlines that creep in via copy-paste. */
function envTrim(name, fallback) {
  const v = process.env[name];
  return v != null && String(v).trim() ? String(v).trim() : fallback;
}

/** Free monthly allowance: 5M tokens. Launch promo: $0.10 / 1M after that.
 *  Raising the rate is apply-pricing-30c.sh, and only after an explicit approval. */
const FREE_TOKENS_PER_MONTH = 5_000_000;
const USD_PER_MILLION = 0.1;
const TOKENS_PER_BILLING_UNIT = 1_000_000; // 1M tokens @ $0.10
const DEFAULT_CREDIT_LIMIT_USD = 10;
const MIN_CREDIT_LIMIT_USD = 10;
const MAX_CREDIT_LIMIT_USD = 1000;

function onboardBonusTokens(claims = {}) {
  const n = Number(claims?.sc_onboard_bonus) || 0;
  return Math.max(0, Math.min(30_000, Math.floor(n)));
}

/** Effective free allowance including onboarding quest bonuses (10,000 each). */
function freeAllowance(claims = {}) {
  return FREE_TOKENS_PER_MONTH + onboardBonusTokens(claims);
}

/**
 * Plan definitions.
 * Legacy starter/pro/business map to PAYG behavior so existing subscribers are not cut off.
 */
const PLANS = {
  free: {
    id: "free",
    name: "Free",
    tokens_per_month: FREE_TOKENS_PER_MONTH,
    max_keys: 10,
    price_id: null,
    price: 0,
    metered: false,
    sort_order: 0,
  },
  payg: {
    id: "payg",
    name: "Pay as you go",
    tokens_per_month: -1,
    max_keys: 25,
    price_id: envTrim("STRIPE_PRICE_PAYG", ""),
    price: 0,
    metered: false, // new enables use prepaid credits; legacy meters use sc_metered claim
    price_display: "$0.10 / 1M tokens",
    sort_order: 1,
  },
  starter: {
    id: "starter",
    name: "Starter (legacy)",
    tokens_per_month: -1,
    max_keys: 25,
    price_id: envTrim("STRIPE_PRICE_STARTER", "price_1TmKXNRz9FTLt24kUt3UCfmD"),
    price: 1000,
    metered: false,
    legacy: true,
    sort_order: 90,
  },
  pro: {
    id: "pro",
    name: "Pro (legacy)",
    tokens_per_month: -1,
    max_keys: 25,
    price_id: envTrim("STRIPE_PRICE_PRO", "price_1TmKXRRz9FTLt24k0l62nG20"),
    price: 2000,
    metered: false,
    legacy: true,
    sort_order: 91,
  },
  business: {
    id: "business",
    name: "Business (legacy)",
    tokens_per_month: -1,
    max_keys: 100,
    price_id: envTrim("STRIPE_PRICE_BUSINESS", "price_1TmKXYRz9FTLt24kleasb72P"),
    price: 6000,
    metered: false,
    legacy: true,
    sort_order: 92,
  },
};

function getPlan(planId) {
  return PLANS[planId] || PLANS.free;
}

function getPlanByPriceId(priceId) {
  if (!priceId) return PLANS.free;
  for (const plan of Object.values(PLANS)) {
    if (plan.price_id && plan.price_id === priceId) return plan;
  }
  return PLANS.free;
}

/** True if the account can exceed the free monthly allowance. */
function isPaygEnabled(planId) {
  const id = String(planId || "free");
  if (id === "payg") return true;
  if (id === "starter" || id === "pro" || id === "business") return true;
  return false;
}

function billableTokens(tokensUsed, claims = {}) {
  return Math.max(0, Number(tokensUsed || 0) - freeAllowance(claims));
}

function overageMillions(tokensUsed, claims = {}) {
  const billable = billableTokens(tokensUsed, claims);
  if (billable <= 0) return 0;
  return Math.ceil(billable / TOKENS_PER_BILLING_UNIT);
}

function estimatedOverageUsd(tokensUsed, claims = {}) {
  return overageMillions(tokensUsed, claims) * USD_PER_MILLION;
}

function freeTokensRemaining(tokensUsed, claims = {}) {
  return Math.max(0, freeAllowance(claims) - Number(tokensUsed || 0));
}

function roundUsd(n) {
  return Math.round(Number(n || 0) * 10000) / 10000;
}

/** USD cost for a token delta at $0.10 / 1M (display/aggregate helper). */
function tokensToUsd(tokenCount) {
  // Keep sub-cent precision in micros, then round for display.
  const micros = Math.ceil(Number(tokenCount || 0) * USD_PER_MILLION);
  return Math.round(micros) / 1_000_000;
}

function normalizeCreditLimitUsd(raw, fallback = DEFAULT_CREDIT_LIMIT_USD) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n * 100) / 100;
  return Math.min(MAX_CREDIT_LIMIT_USD, Math.max(MIN_CREDIT_LIMIT_USD, rounded));
}

/** Comped founders / unlimited grants skip wallet + meters. */
function isComped(claims = {}) {
  return Boolean(claims.sc_comped);
}

/** Legacy Stripe metered subscription accounts. */
function isLegacyMetered(claims = {}) {
  if (isComped(claims)) return false;
  if (claims.sc_metered === false) return false;
  if (claims.sc_metered === true) return true;
  const plan = claims.sc_plan;
  if (plan === "starter" || plan === "pro" || plan === "business") return true;
  // Explicit credit fields → prepaid wallet, not meters
  if (claims.sc_credit_limit_usd != null || claims.sc_credit_balance_usd != null) return false;
  // Old payg subscription without credit fields
  if (claims.sc_subscription_id && plan === "payg") return true;
  return false;
}

/** New PAYG = prepaid credit wallet. */
function isCreditWallet(claims = {}) {
  if (isComped(claims)) return false;
  if (isLegacyMetered(claims)) return false;
  if (claims.sc_metered === false && isPaygEnabled(claims.sc_plan)) return true;
  if (claims.sc_credit_limit_usd != null || claims.sc_credit_balance_usd != null) {
    return isPaygEnabled(claims.sc_plan) || Number(claims.sc_credit_balance_usd || 0) > 0;
  }
  return false;
}

/**
 * Report PAYG overage to Stripe meters — legacy metered accounts only.
 */
async function reportPaygUsage(owner, tokensInThisMonth) {
  const claims = owner.customClaims || {};
  if (!isPaygEnabled(claims.sc_plan)) return null;
  if (isComped(claims) || isCreditWallet(claims)) return null;
  if (!isLegacyMetered(claims)) return null;

  const status = claims.sc_subscription_status;
  if (status && status !== "active" && status !== "trialing") return null;

  const customerId = claims.sc_customer_id;
  if (!customerId) return null;

  const billable = billableTokens(tokensInThisMonth, claims);
  const { loadLedger, markTokensReported } = require("./billing-ledger");
  const ledger = await loadLedger(owner.uid, claims);
  const alreadyReported = Number(ledger.tokens_reported || 0);
  const delta = billable - alreadyReported;
  if (delta <= 0) return null;

  const unitsNow = Math.ceil(billable / TOKENS_PER_BILLING_UNIT);
  const unitsWas = Math.ceil(alreadyReported / TOKENS_PER_BILLING_UNIT);
  const unitDelta = unitsNow - unitsWas;
  if (unitDelta <= 0) {
    return { tokens_reported: billable, units: 0 };
  }

  const eventName = envTrim("STRIPE_METER_EVENT_NAME", "supercompress_tokens_millions");
  // Idempotent per customer + absolute billable watermark.
  const idempotencyKey = `sc_meter_${customerId}_${billable}`.slice(0, 255);

  try {
    const stripe = getStripe();
    await stripe.billing.meterEvents.create(
      {
        event_name: eventName,
        payload: {
          stripe_customer_id: customerId,
          value: String(unitDelta),
        },
        identifier: idempotencyKey,
      },
      { idempotencyKey }
    );

    await markTokensReported(owner.uid, billable, claims);
    return { tokens_reported: billable, units: unitDelta };
  } catch (err) {
    console.warn("PAYG usage report failed:", err.message || err);
    return null;
  }
}

/**
 * Create a Stripe Checkout session that charges `creditUsd` and saves the card
 * for optional auto-recharge.
 */
async function createCreditTopUpCheckout({
  customerId,
  userId,
  creditUsd,
  autoRecharge = true,
  baseUrl = "https://www.supercompress.dev",
  kind = "credit_topup",
}) {
  const stripe = getStripe();
  const amount = normalizeCreditLimitUsd(creditUsd);
  const unitAmount = Math.round(amount * 100);

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: unitAmount,
          product_data: {
            name: "SuperCompress credit",
            description: `$${amount.toFixed(2)} prepaid usage credit ($0.10 / 1M tokens after 5M free/mo)`,
          },
        },
      },
    ],
    // Include session_id so the dashboard can reconcile credits if the webhook fails
    success_url: `${baseUrl}/dashboard?billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/dashboard?billing=cancel`,
    metadata: {
      user_id: userId,
      plan_id: "payg",
      kind,
      credit_usd: String(amount),
      auto_recharge: autoRecharge ? "true" : "false",
    },
    payment_intent_data: {
      setup_future_usage: "off_session",
      metadata: {
        user_id: userId,
        plan_id: "payg",
        kind,
        credit_usd: String(amount),
      },
    },
    allow_promotion_codes: false,
    billing_address_collection: "auto",
  });

  return { session, amount };
}

/**
 * Charge the customer's default payment method for another credit pack.
 * On success, credits Auth claims immediately (webhook is idempotent via PI id).
 * Returns { ok, balanceAdd, paymentIntentId, balance } or { ok:false, error }.
 */
/** Explicit true only. Legacy unset stays OFF until checkout consent. */
function isAutoRechargeEnabled(claims = {}, ledger = {}) {
  if (ledger.auto_recharge === true || claims.sc_auto_recharge === true) return true;
  if (ledger.auto_recharge === false || claims.sc_auto_recharge === false) return false;
  return false;
}

function isIndiaMandateError(err) {
  const msg = String(err?.message || err || "");
  const code = String(err?.code || "");
  return (
    /mandate for off-session card payments made with cards issued in India/i.test(msg) ||
    /india-recurring-payments/i.test(msg) ||
    code === "india_recurring_payment_mandate_required"
  );
}

async function cancelStaleAutoRechargeIntents(stripe, customerId, { keepId = null } = {}) {
  try {
    const list = await stripe.paymentIntents.list({ customer: customerId, limit: 20 });
    for (const pi of list.data || []) {
      if (keepId && pi.id === keepId) continue;
      if (pi.metadata?.kind !== "credit_auto_recharge") continue;
      if (!["requires_confirmation", "requires_payment_method", "requires_action"].includes(pi.status)) {
        continue;
      }
      try {
        await stripe.paymentIntents.cancel(pi.id, { cancellation_reason: "abandoned" });
      } catch (err) {
        console.warn("Could not cancel stale auto-recharge PI:", pi.id, err.message || err);
      }
    }
  } catch (err) {
    console.warn("Stale auto-recharge cleanup failed:", err.message || err);
  }
}

/**
 * On-session Checkout fallback when silent off-session debit cannot complete
 * (India RBI, 3DS, declined card, missing PM). Reuses open sessions.
 */
async function createAutoRechargeCheckout({ customerId, userId, creditUsd }) {
  const { session, amount } = await createCreditTopUpCheckout({
    customerId,
    userId,
    creditUsd,
    autoRecharge: true,
    kind: "credit_auto_recharge_checkout",
  });
  return { checkoutUrl: session.url, sessionId: session.id, amount };
}

async function fallbackAutoRechargeToCheckout({
  stripe,
  owner,
  customerId,
  amount,
  cycle,
  reason,
}) {
  const {
    createOrReuseRecoveryCheckout,
    scheduleAutoRechargeRecoveryNotify,
  } = require("./auto-recharge-recovery");

  await cancelStaleAutoRechargeIntents(stripe, customerId);
  const checkout = await createOrReuseRecoveryCheckout({
    stripe,
    customerId,
    userId: owner.uid,
    creditUsd: amount,
    createCheckout: createAutoRechargeCheckout,
  });

  const email = owner.email || owner.customClaims?.email || null;
  const firstName =
    (owner.displayName || owner.customClaims?.name || "").toString().trim().split(/\s+/)[0] ||
    null;
  scheduleAutoRechargeRecoveryNotify({
    uid: owner.uid,
    email,
    firstName,
    amount: checkout.amount || amount,
    checkoutUrl: checkout.checkoutUrl,
    reason,
    cycle,
    customerId,
  });

  return {
    ok: false,
    error: reason,
    checkoutUrl: checkout.checkoutUrl,
    sessionId: checkout.sessionId,
    amount: checkout.amount || amount,
    recovery: true,
  };
}

async function attemptAutoRecharge(owner) {
  const claims = owner.customClaims || {};
  const { loadLedger, acquireRechargeLock, creditBalance } = require("./billing-ledger");
  const { needsCheckoutFallback } = require("./auto-recharge-recovery");
  const ledger = await loadLedger(owner.uid, claims);
  if (!isAutoRechargeEnabled(claims, ledger)) {
    return { ok: false, error: "auto_recharge_disabled" };
  }
  const customerId = claims.sc_customer_id || ledger.customer_id;
  if (!customerId) {
    return { ok: false, error: "no_customer" };
  }

  const amount = normalizeCreditLimitUsd(
    ledger.credit_limit_usd || claims.sc_credit_limit_usd,
    DEFAULT_CREDIT_LIMIT_USD
  );
  const lock = await acquireRechargeLock(owner.uid);
  if (!lock.acquired) {
    // Another compress is already charging — surface any open Checkout so the
    // client can still complete payment instead of a dead-end 402.
    try {
      const { findOpenCreditCheckout } = require("./auto-recharge-recovery");
      const open = await findOpenCreditCheckout(getStripe(), customerId, amount);
      if (open?.url) {
        return {
          ok: false,
          error: "recharge_in_progress",
          checkoutUrl: open.url,
          sessionId: open.id,
          amount: Number(open.amount_total || 0) / 100 || amount,
        };
      }
    } catch (_) {}
    return { ok: false, error: "recharge_in_progress" };
  }

  const stripe = getStripe();
  // Cycle id advances after each successful recharge so a user who burns
  // through multiple packs in one hour can recharge again. Concurrent
  // compressions with the same cycle still share one Stripe PI.
  const cycle = Number(ledger.auto_recharge_cycle || claims.sc_auto_recharge_cycle || 0) || 0;
  const idempotencyKey = `sc_ar_${owner.uid}_${Math.round(amount * 100)}_c${cycle}`.slice(0, 255);

  try {
    const customer = await stripe.customers.retrieve(customerId);
    let pm =
      customer.invoice_settings?.default_payment_method ||
      claims.sc_default_payment_method ||
      null;
    if (typeof pm === "object" && pm?.id) pm = pm.id;

    let pmObj = null;
    if (pm) {
      try {
        pmObj = await stripe.paymentMethods.retrieve(pm);
      } catch {
        pmObj = null;
      }
    }
    if (!pm) {
      const pms = await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
      pm = pms.data[0]?.id || null;
      pmObj = pms.data[0] || null;
    }
    if (!pm) {
      return await fallbackAutoRechargeToCheckout({
        stripe,
        owner,
        customerId,
        amount,
        cycle,
        reason: "no_payment_method",
      });
    }

    const cardCountry = String(pmObj?.card?.country || "").toUpperCase();
    if (cardCountry === "IN") {
      // India cards cannot be charged off-session via bare PaymentIntents (RBI).
      // Never create orphan requires_confirmation PIs — go straight to Checkout + email.
      return await fallbackAutoRechargeToCheckout({
        stripe,
        owner,
        customerId,
        amount,
        cycle,
        reason: "india_requires_checkout",
      });
    }

    let pi;
    try {
      pi = await stripe.paymentIntents.create(
        {
          amount: Math.round(amount * 100),
          currency: "usd",
          customer: customerId,
          payment_method: pm,
          off_session: true,
          confirm: true,
          // Off-session card debit only — redirect methods break silent recharge.
          automatic_payment_methods: { enabled: true, allow_redirects: "never" },
          description: `SuperCompress auto-recharge $${amount.toFixed(2)}`,
          metadata: {
            user_id: owner.uid,
            plan_id: "payg",
            kind: "credit_auto_recharge",
            credit_usd: String(amount),
          },
        },
        { idempotencyKey }
      );
    } catch (err) {
      await cancelStaleAutoRechargeIntents(stripe, customerId);
      if (isIndiaMandateError(err) || needsCheckoutFallback(err)) {
        return await fallbackAutoRechargeToCheckout({
          stripe,
          owner,
          customerId,
          amount,
          cycle,
          reason: isIndiaMandateError(err)
            ? "india_requires_checkout"
            : err.code || err.message || "charge_requires_checkout",
        });
      }
      throw err;
    }

    if (pi.status === "requires_confirmation" || pi.status === "requires_action") {
      try {
        await stripe.paymentIntents.cancel(pi.id, { cancellation_reason: "abandoned" });
      } catch {}
      return await fallbackAutoRechargeToCheckout({
        stripe,
        owner,
        customerId,
        amount,
        cycle,
        reason: `payment_${pi.status}`,
      });
    }

    // processing: webhook will credit on payment_intent.succeeded — do not Checkout-spam.
    if (pi.status === "processing") {
      return { ok: false, error: "payment_processing", paymentIntentId: pi.id, pending: true };
    }

    if (pi.status !== "succeeded") {
      if (needsCheckoutFallback({ status: pi.status, message: pi.last_payment_error?.message })) {
        return await fallbackAutoRechargeToCheckout({
          stripe,
          owner,
          customerId,
          amount,
          cycle,
          reason: `payment_${pi.status}`,
        });
      }
      return { ok: false, error: `payment_${pi.status}`, paymentIntentId: pi.id };
    }

    const paidUsd = roundUsd(Number(pi.amount || 0) / 100);
    if (paidUsd <= 0) {
      return { ok: false, error: "invalid_paid_amount", paymentIntentId: pi.id };
    }

    const credited = await creditBalance({
      uid: owner.uid,
      creditUsd: paidUsd,
      creditKey: `pi_${pi.id}`,
      claims,
      patch: {
        credit_limit_usd: amount,
        auto_recharge: true,
        auto_recharge_cycle: cycle + 1,
        customer_id: customerId,
      },
    });

    try {
      await stripe.paymentIntents.update(pi.id, {
        metadata: { ...(pi.metadata || {}), sc_credited: "true" },
      });
    } catch (err) {
      console.warn("Could not stamp auto-recharge PI:", err.message || err);
    }

    return {
      ok: true,
      balanceAdd: credited.already ? 0 : paidUsd,
      paymentIntentId: pi.id,
      balance: credited.balance,
    };
  } catch (err) {
    console.warn("Auto-recharge failed:", err.message || err);
    try {
      if (needsCheckoutFallback(err)) {
        return await fallbackAutoRechargeToCheckout({
          stripe: getStripe(),
          owner,
          customerId,
          amount,
          cycle,
          reason: err.code || err.message || "charge_failed",
        });
      }
    } catch (fallbackErr) {
      console.warn("Auto-recharge checkout fallback failed:", fallbackErr.message || fallbackErr);
    }
    return { ok: false, error: err.message || "charge_failed" };
  } finally {
    if (lock.release) await lock.release();
  }
}

module.exports = {
  getStripe,
  PLANS,
  getPlan,
  getPlanByPriceId,
  FREE_TOKENS_PER_MONTH,
  USD_PER_MILLION,
  TOKENS_PER_BILLING_UNIT,
  DEFAULT_CREDIT_LIMIT_USD,
  MIN_CREDIT_LIMIT_USD,
  MAX_CREDIT_LIMIT_USD,
  isPaygEnabled,
  freeAllowance,
  onboardBonusTokens,
  billableTokens,
  overageMillions,
  estimatedOverageUsd,
  freeTokensRemaining,
  reportPaygUsage,
  roundUsd,
  tokensToUsd,
  normalizeCreditLimitUsd,
  isComped,
  isLegacyMetered,
  isCreditWallet,
  createCreditTopUpCheckout,
  attemptAutoRecharge,
  isAutoRechargeEnabled,
};
