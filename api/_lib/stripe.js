/**
 * Stripe client — initialized once per warm lambda.
 * Requires STRIPE_SECRET_KEY env var.
 *
 * Pricing model:
 *   Free:  1M tokens / month
 *   PAYG:  prepaid credit wallet — $0.30 per 1M tokens after free allowance
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

/** Free monthly allowance: 1M tokens. Paid usage is $0.30 / 1M after that. */
const FREE_TOKENS_PER_MONTH = 1_000_000;
const USD_PER_MILLION = 0.3;
const TOKENS_PER_BILLING_UNIT = 1_000_000; // 1M tokens @ $0.30
const DEFAULT_CREDIT_LIMIT_USD = 10;
const MIN_CREDIT_LIMIT_USD = 10;
const MAX_CREDIT_LIMIT_USD = 1000;

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
    price_display: "$0.30 / 1M tokens",
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

function billableTokens(tokensUsed) {
  return Math.max(0, Number(tokensUsed || 0) - FREE_TOKENS_PER_MONTH);
}

function overageMillions(tokensUsed) {
  const billable = billableTokens(tokensUsed);
  if (billable <= 0) return 0;
  return Math.ceil(billable / TOKENS_PER_BILLING_UNIT);
}

function estimatedOverageUsd(tokensUsed) {
  return overageMillions(tokensUsed) * USD_PER_MILLION;
}

function freeTokensRemaining(tokensUsed) {
  return Math.max(0, FREE_TOKENS_PER_MONTH - Number(tokensUsed || 0));
}

function roundUsd(n) {
  return Math.round(Number(n || 0) * 10000) / 10000;
}

/** USD cost for a token delta at $0.30 / 1M (display/aggregate helper). */
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

  const billable = billableTokens(tokensInThisMonth);
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
  autoRecharge = false,
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
            description: `$${amount.toFixed(2)} prepaid usage credit ($0.30 / 1M tokens after 1M free/mo)`,
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
async function attemptAutoRecharge(owner) {
  const claims = owner.customClaims || {};
  const { loadLedger, acquireRechargeLock, creditBalance } = require("./billing-ledger");
  const ledger = await loadLedger(owner.uid, claims);
  if (!(claims.sc_auto_recharge || ledger.auto_recharge)) {
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
    return { ok: false, error: "recharge_in_progress" };
  }

  const stripe = getStripe();
  // Hour-bucketed key so concurrent compressions share one PI attempt.
  const hourBucket = new Date().toISOString().slice(0, 13).replace(/[-:T]/g, "");
  const idempotencyKey = `sc_ar_${owner.uid}_${Math.round(amount * 100)}_${hourBucket}`.slice(0, 255);

  try {
    const customer = await stripe.customers.retrieve(customerId);
    let pm =
      customer.invoice_settings?.default_payment_method ||
      claims.sc_default_payment_method ||
      null;
    if (typeof pm === "object" && pm?.id) pm = pm.id;

    if (!pm) {
      const pms = await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
      pm = pms.data[0]?.id || null;
    }
    if (!pm) {
      return { ok: false, error: "no_payment_method" };
    }

    const pi = await stripe.paymentIntents.create(
      {
        amount: Math.round(amount * 100),
        currency: "usd",
        customer: customerId,
        payment_method: pm,
        off_session: true,
        confirm: true,
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

    if (pi.status !== "succeeded") {
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
};
