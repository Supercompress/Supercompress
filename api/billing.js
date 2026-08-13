/**
 * /api/billing — consolidated billing endpoint.
 *
 * GET  /api/billing  → free allowance + credit wallet / PAYG status (auth required)
 * POST /api/billing  → checkout / portal / credit settings (auth required)
 *   { action: "enable_payg", credit_limit_usd?, auto_recharge? } → credit top-up Checkout
 *   { action: "top_up", credit_limit_usd? }                     → another credit pack
 *   { action: "update_credit_settings", credit_limit_usd?, auto_recharge? }
 *   { action: "reconcile_checkout", session_id } → apply paid credit session (webhook fallback)
 *   { action: "portal" } | { action: "cancel" | "reactivate" }
 */
const { json } = require("./_lib/http");
const { verifyUser, initFirebaseAdmin } = require("./_lib/auth");
const admin = require("firebase-admin");
const {
  getStripe,
  getPlan,
  getPlanByPriceId,
  FREE_TOKENS_PER_MONTH,
  USD_PER_MILLION,
  DEFAULT_CREDIT_LIMIT_USD,
  MIN_CREDIT_LIMIT_USD,
  MAX_CREDIT_LIMIT_USD,
  isPaygEnabled,
  billableTokens,
  overageMillions,
  estimatedOverageUsd,
  freeTokensRemaining,
  normalizeCreditLimitUsd,
  isComped,
  isLegacyMetered,
  isCreditWallet,
  createCreditTopUpCheckout,
  roundUsd,
} = require("./_lib/stripe");
const {
  reconcileCreditCheckout,
  reconcileOutstandingCreditCheckouts,
} = require("./_lib/credit-topup");
const { loadStore, mutateStore } = require("./_lib/store");

const BASE_URL = "https://www.supercompress.dev";

async function loadStoreOrEmpty() {
  try {
    return await loadStore();
  } catch (err) {
    if (err.status !== 503) throw err;
    console.warn("Billing continuing without Blob store:", err.message);
    return { keys: {}, usage: {}, subscriptions: {} };
  }
}

async function findStripeBilling(user) {
  const stripe = getStripe();
  const uid = String(user.uid).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  let customer = null;

  const matches = await stripe.customers.search({
    query: `metadata['user_id']:'${uid}'`,
    limit: 1,
  });
  customer = matches.data[0] || null;

  if (!customer && user.email) {
    const byEmail = await stripe.customers.list({ email: user.email, limit: 1 });
    customer = byEmail.data[0] || null;
  }

  if (!customer) return { customer: null, subscription: null };

  if (customer.metadata?.user_id !== user.uid) {
    customer = await stripe.customers.update(customer.id, {
      metadata: { ...customer.metadata, user_id: user.uid },
    });
  }

  const subscriptions = await stripe.subscriptions.list({
    customer: customer.id,
    status: "all",
    limit: 20,
  });
  const priority = ["active", "trialing", "past_due", "unpaid", "incomplete"];
  const subscription = subscriptions.data
    .filter((sub) => sub.status !== "canceled")
    .sort((a, b) => priority.indexOf(a.status) - priority.indexOf(b.status))[0] || null;

  return { customer, subscription };
}

function resolvePlanId(sub, claimsPlan) {
  const fromSub = sub?.plan_id;
  if (fromSub && fromSub !== "free") return fromSub;
  if (claimsPlan && claimsPlan !== "free") return claimsPlan;
  return fromSub || claimsPlan || "free";
}

async function ensureCustomer(user, existingSub, stripeBilling) {
  let customerId = existingSub?.stripe_customer_id || stripeBilling.customer?.id
    || (await admin.auth().getUser(user.uid).catch(() => null))?.customClaims?.sc_customer_id;
  if (customerId) return customerId;

  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email: user.email || undefined,
    metadata: { user_id: user.uid },
  });
  return customer.id;
}

async function patchCreditClaims(userId, patch) {
  if (!initFirebaseAdmin()) {
    const err = new Error("Firebase admin not configured");
    err.status = 503;
    throw err;
  }
  const { patchUserClaims } = require("./_lib/billing-ledger");
  return patchUserClaims(userId, (live) => ({ ...live, ...patch }));
}

/* ── GET: free allowance + credit / PAYG status ── */
async function handleGet(req, res, user) {
  const store = await loadStoreOrEmpty();
  initFirebaseAdmin();
  let owner = await admin.auth().getUser(user.uid).catch(() => ({ uid: user.uid, customClaims: {} }));
  let claims = owner.customClaims || {};

  // Self-heal paid Checkout that never credited (webhook / Firestore outage).
  // Only when wallet looks empty — happy-path GET stays cheap; success-page
  // reconcile + webhook cover top-ups while balance > 0.
  const looksEmpty =
    claims.sc_credit_balance_usd == null || Number(claims.sc_credit_balance_usd) <= 0;
  if (looksEmpty) {
    try {
      const healed = await reconcileOutstandingCreditCheckouts({
        userId: user.uid,
        customerId: claims.sc_customer_id || null,
        claims,
        limit: 14,
      });
      if (healed.applied > 0) {
        owner = await admin.auth().getUser(user.uid);
        claims = owner.customClaims || {};
        console.log(
          `billing GET healed ${healed.applied} credit session(s) for ${user.uid}; balance=$${healed.credit_balance_usd}`
        );
      }
    } catch (err) {
      console.warn("outstanding credit reconcile skipped:", err.message || err);
    }
  }

  let sub = store.subscriptions?.[user.uid];
  if (!sub) {
    try {
      const { customer, subscription } = await findStripeBilling(user);
      if (customer) {
        const priceId = subscription?.items?.data?.[0]?.price?.id;
        sub = {
          stripe_customer_id: customer.id,
          stripe_subscription_id: subscription?.id || null,
          plan_id: subscription
            ? (claims.sc_plan === "payg" ? "payg" : getPlanByPriceId(priceId).id)
            : (claims.sc_plan || "free"),
          status: subscription?.status || (claims.sc_plan === "payg" ? "active" : "active"),
          cancel_at_period_end: subscription?.cancel_at_period_end || false,
          current_period_start: subscription?.current_period_start
            ? new Date(subscription.current_period_start * 1000).toISOString()
            : null,
          current_period_end: subscription?.current_period_end
            ? new Date(subscription.current_period_end * 1000).toISOString()
            : null,
          credit_balance_usd: claims.sc_credit_balance_usd,
          credit_limit_usd: claims.sc_credit_limit_usd,
          auto_recharge: claims.sc_auto_recharge,
        };
      }
    } catch (err) {
      console.warn("Stripe lookup skipped:", err.message || err);
    }
  }

  const planId = resolvePlanId(sub, claims.sc_plan);
  const plan = getPlan(planId);
  const payg = isPaygEnabled(planId) || isComped(claims);
  const creditWallet = isCreditWallet(claims) || (payg && !isLegacyMetered(claims) && !isComped(claims) && claims.sc_credit_balance_usd != null);
  const legacyMetered = isLegacyMetered(claims);
  const activeSub = sub?.status === "active" || sub?.status === "trialing" || (payg && (creditWallet || isComped(claims)));

  const periodStart = sub?.current_period_start
    ? new Date(sub.current_period_start)
    : new Date(new Date().toISOString().slice(0, 7) + "-01T00:00:00Z");

  let tokensUsedThisPeriod = 0;
  let requestsThisPeriod = 0;

  // Prefer transactional billing ledger (source of truth) over store/claims mirrors.
  try {
    const { loadLedger, microsToUsd } = require("./_lib/billing-ledger");
    const ledger = await loadLedger(user.uid, claims);
    tokensUsedThisPeriod = Number(ledger.tokens_in || 0);
    requestsThisPeriod = Number(ledger.requests || 0);
    if (ledger.credit_balance_micros != null) {
      claims.sc_credit_balance_usd = roundUsd(microsToUsd(ledger.credit_balance_micros));
    }
    if (ledger.credit_limit_usd != null) claims.sc_credit_limit_usd = ledger.credit_limit_usd;
    if (ledger.auto_recharge != null) claims.sc_auto_recharge = Boolean(ledger.auto_recharge);
  } catch (err) {
    console.warn("billing ledger read skipped:", err.message || err);
    const keys = store.keys || {};
    const usage = store.usage || {};
    for (const [keyId, keyRec] of Object.entries(keys)) {
      if (keyRec && keyRec.user_id === user.uid && !keyRec.revoked) {
        const keyUsage = usage[keyId] || {};
        for (const [day, rec] of Object.entries(keyUsage)) {
          if (rec && new Date(day + "T00:00:00Z") >= periodStart) {
            tokensUsedThisPeriod += rec.tokens_in || 0;
            requestsThisPeriod += rec.requests || 0;
          }
        }
      }
    }
    if (tokensUsedThisPeriod === 0 && requestsThisPeriod === 0) {
      const claimUsage = claims.sc_usage;
      const currentMonth = new Date().toISOString().slice(0, 7);
      if (claimUsage?.month === currentMonth) {
        tokensUsedThisPeriod = claimUsage.tokens_in || 0;
        requestsThisPeriod = claimUsage.requests || 0;
      }
    }
  }

  const freeRemaining = freeTokensRemaining(tokensUsedThisPeriod);
  const billable = billableTokens(tokensUsedThisPeriod);
  const overageUsd = estimatedOverageUsd(tokensUsedThisPeriod);
  const creditLimit = normalizeCreditLimitUsd(
    claims.sc_credit_limit_usd ?? sub?.credit_limit_usd,
    DEFAULT_CREDIT_LIMIT_USD
  );
  const creditBalance = roundUsd(
    claims.sc_credit_balance_usd != null
      ? claims.sc_credit_balance_usd
      : (sub?.credit_balance_usd != null ? sub.credit_balance_usd : (payg && creditWallet ? 0 : null))
  );
  const { isAutoRechargeEnabled } = require("./_lib/stripe");
  const autoRecharge = isAutoRechargeEnabled(claims, {
    auto_recharge: sub?.auto_recharge,
    customer_id: claims.sc_customer_id || sub?.stripe_customer_id,
  });

  return json(res, 200, {
    plan: plan.id,
    plan_name: plan.name,
    status: sub?.status || (payg ? "active" : "active"),
    free_tokens_per_month: FREE_TOKENS_PER_MONTH,
    free_tokens_remaining: freeRemaining,
    usd_per_million: USD_PER_MILLION,
    tokens_per_month: FREE_TOKENS_PER_MONTH,
    unlimited: isComped(claims) || legacyMetered,
    max_keys: plan.max_keys,
    tokens_used_this_period: tokensUsedThisPeriod,
    requests_this_period: requestsThisPeriod,
    tokens_remaining: isComped(claims) || legacyMetered ? -1 : freeRemaining,
    billable_tokens: billable,
    overage_millions: overageMillions(tokensUsedThisPeriod),
    estimated_overage_usd: overageUsd,
    usage_pct: FREE_TOKENS_PER_MONTH > 0
      ? Math.min(100, Math.round((Math.min(tokensUsedThisPeriod, FREE_TOKENS_PER_MONTH) / FREE_TOKENS_PER_MONTH) * 10000) / 100)
      : 0,
    period_start: periodStart.toISOString(),
    period_end: sub?.current_period_end
      ? new Date(sub.current_period_end).toISOString()
      : new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    stripe_customer_id: sub?.stripe_customer_id || claims.sc_customer_id || null,
    payg_enabled: payg,
    has_active_subscription: payg && activeSub,
    cancel_at_period_end: sub?.cancel_at_period_end || false,
    price_display: plan.price_display || (payg ? "$0.30 / 1M tokens" : "Free"),
    credit_wallet: Boolean(creditWallet || (payg && !legacyMetered && !isComped(claims))),
    credit_limit_usd: creditLimit,
    credit_balance_usd: creditBalance,
    auto_recharge: autoRecharge,
    legacy_metered: legacyMetered,
    comped: isComped(claims),
    default_credit_limit_usd: DEFAULT_CREDIT_LIMIT_USD,
    min_credit_limit_usd: MIN_CREDIT_LIMIT_USD,
    max_credit_limit_usd: MAX_CREDIT_LIMIT_USD,
    limit_reached: !payg && !isComped(claims) && !legacyMetered && freeRemaining === 0,
    upgrade_url: "https://www.supercompress.dev/dashboard#billing",
    paywall:
      !payg && !isComped(claims) && !legacyMetered && freeRemaining === 0
        ? {
            title: "Compression paused — free allowance used",
            detail: "You've hit your free 1M tokens this month. Add a payment method to unlock.",
            cta: "Unlock compression",
            price: "$0.30 / 1M tokens after free",
          }
        : null,
    plans: [
      {
        id: "free",
        name: "Free",
        tokens_per_month: FREE_TOKENS_PER_MONTH,
        max_keys: getPlan("free").max_keys,
        price: 0,
        price_display: "Free",
        unlimited: false,
      },
      {
        id: "payg",
        name: "Pay as you go",
        tokens_per_month: -1,
        max_keys: getPlan("payg").max_keys,
        price: 0,
        price_display: "$0.30 / 1M tokens",
        unlimited: false,
        credit_wallet: true,
        default_credit_limit_usd: DEFAULT_CREDIT_LIMIT_USD,
        min_credit_limit_usd: MIN_CREDIT_LIMIT_USD,
        max_credit_limit_usd: MAX_CREDIT_LIMIT_USD,
      },
    ],
  });
}

async function startCreditCheckout(req, res, user, body, existingSub, stripeBilling) {
  const creditUsd = normalizeCreditLimitUsd(body.credit_limit_usd, DEFAULT_CREDIT_LIMIT_USD);
  // Default ON — only an explicit false opts out (dashboard checkbox is checked by default).
  const autoRecharge = !(body.auto_recharge === false || body.auto_recharge === "false");
  const kind = body.action === "top_up" ? "credit_topup" : "credit_enable";

  const customerId = await ensureCustomer(user, existingSub, stripeBilling);

  // Do NOT flip sc_metered / wallet claims before payment succeeds — a canceled
  // Checkout must not reclassify a legacy metered subscriber. Persist prefs only
  // in the subscriptions store (+ Checkout metadata) until the webhook credits.
  try {
    await mutateStore((s) => {
      if (!s.subscriptions) s.subscriptions = {};
      s.subscriptions[user.uid] = {
        ...(s.subscriptions[user.uid] || {}),
        stripe_customer_id: customerId,
        plan_id: s.subscriptions[user.uid]?.plan_id || "free",
        pending_credit_limit_usd: creditUsd,
        pending_auto_recharge: autoRecharge,
        credit_limit_usd: creditUsd,
        auto_recharge: autoRecharge,
        updated_at: new Date().toISOString(),
      };
      return true;
    });
  } catch (err) {
    if (err.status !== 503) throw err;
  }

  // Safe claim touch: customer id only (needed for Checkout), never sc_metered.
  try {
    await patchCreditClaims(user.uid, { sc_customer_id: customerId });
  } catch (err) {
    console.warn("checkout customer claim patch skipped:", err.message || err);
  }

  const { session, amount } = await createCreditTopUpCheckout({
    customerId,
    userId: user.uid,
    creditUsd,
    autoRecharge,
    baseUrl: BASE_URL,
    kind,
  });

  return json(res, 200, {
    url: session.url,
    session_id: session.id,
    credit_limit_usd: amount,
    auto_recharge: autoRecharge,
  });
}

/* ── POST: create checkout or portal session ── */
async function handlePost(req, res, user) {
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const store = await loadStoreOrEmpty();
  const storedSub = store.subscriptions?.[user.uid];
  let stripeBilling = { customer: null, subscription: null };
  try {
    stripeBilling = await findStripeBilling(user);
  } catch (err) {
    console.warn("Stripe lookup skipped:", err.message || err);
  }
  const existingSub = storedSub || (stripeBilling.customer ? {
    stripe_customer_id: stripeBilling.customer.id,
    stripe_subscription_id: stripeBilling.subscription?.id || null,
    plan_id: stripeBilling.subscription
      ? getPlanByPriceId(stripeBilling.subscription.items?.data?.[0]?.price?.id).id
      : "free",
    status: stripeBilling.subscription?.status || "active",
  } : null);

  if (body.action === "reconcile_checkout") {
    const sessionId = String(body.session_id || "").trim();
    if (!sessionId.startsWith("cs_")) {
      return json(res, 400, { detail: "session_id required" });
    }
    try {
      const result = await reconcileCreditCheckout({ userId: user.uid, sessionId });
      if (!result.ok) {
        return json(res, 400, { detail: result.detail || "Could not reconcile checkout" });
      }
      return json(res, 200, {
        credit_balance_usd: result.credit_balance_usd,
        credited_usd: result.credited_usd,
        already: result.already,
        message: result.already
          ? "Credits already applied."
          : `Added $${Number(result.credited_usd || 0).toFixed(2)} in credits.`,
      });
    } catch (err) {
      console.error("reconcile_checkout failed:", err);
      return json(res, 500, { detail: err.message || "Reconcile failed" });
    }
  }

  if (body.action === "portal") {
    const customerId = existingSub?.stripe_customer_id
      || (await admin.auth().getUser(user.uid).catch(() => null))?.customClaims?.sc_customer_id;
    if (!customerId) {
      return json(res, 400, { detail: "No billing account found. Add credits first." });
    }
    const stripe = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${BASE_URL}/dashboard`,
    });
    return json(res, 200, { url: session.url });
  }

  if (body.action === "update_credit_settings") {
    initFirebaseAdmin();
    const owner = await admin.auth().getUser(user.uid);
    const claims = owner.customClaims || {};
    if (!isPaygEnabled(claims.sc_plan) && !isCreditWallet(claims) && claims.sc_credit_balance_usd == null) {
      return json(res, 400, { detail: "Enable pay-as-you-go / add credits first." });
    }
    const patch = { sc_metered: false };
    if (body.credit_limit_usd != null) {
      patch.sc_credit_limit_usd = normalizeCreditLimitUsd(body.credit_limit_usd);
    }
    if (body.auto_recharge != null) {
      patch.sc_auto_recharge = body.auto_recharge === true || body.auto_recharge === "true";
    }
    const next = await patchCreditClaims(user.uid, patch);
    try {
      await mutateStore((s) => {
        if (!s.subscriptions) s.subscriptions = {};
        s.subscriptions[user.uid] = {
          ...(s.subscriptions[user.uid] || {}),
          credit_limit_usd: next.sc_credit_limit_usd,
          auto_recharge: next.sc_auto_recharge,
          updated_at: new Date().toISOString(),
        };
        return true;
      });
    } catch (err) {
      if (err.status !== 503) throw err;
    }
    return json(res, 200, {
      credit_limit_usd: next.sc_credit_limit_usd,
      auto_recharge: Boolean(next.sc_auto_recharge),
      credit_balance_usd: roundUsd(next.sc_credit_balance_usd || 0),
      message: "Credit settings updated.",
    });
  }

  if (body.action === "cancel") {
    if (!existingSub?.stripe_subscription_id) {
      // Credit-wallet users: disable PAYG by clearing plan (keep leftover balance)
      initFirebaseAdmin();
      const owner = await admin.auth().getUser(user.uid);
      if (isCreditWallet(owner.customClaims || {}) || owner.customClaims?.sc_plan === "payg") {
        await patchCreditClaims(user.uid, {
          sc_plan: "free",
          sc_subscription_status: "canceled",
          sc_auto_recharge: false,
        });
        return json(res, 200, {
          status: "canceled",
          message: "Pay-as-you-go disabled. Remaining credit stays on the account until used or you re-enable.",
        });
      }
      return json(res, 400, { detail: "No active subscription to cancel" });
    }
    const stripe = getStripe();
    const updated = await stripe.subscriptions.update(
      existingSub.stripe_subscription_id,
      { cancel_at_period_end: true }
    );
    await mutateStore((s) => {
      if (!s.subscriptions) s.subscriptions = {};
      if (s.subscriptions[user.uid]) {
        s.subscriptions[user.uid].cancel_at_period_end = true;
        s.subscriptions[user.uid].status = "active";
        s.subscriptions[user.uid].updated_at = new Date().toISOString();
      }
      return true;
    });
    return json(res, 200, {
      status: "canceled",
      cancel_at_period_end: true,
      current_period_end: new Date(updated.current_period_end * 1000).toISOString(),
      message: "Pay-as-you-go will end at the close of the current billing period. You'll return to the free allowance.",
    });
  }

  if (body.action === "reactivate") {
    if (!existingSub?.stripe_subscription_id) {
      return json(res, 400, { detail: "No subscription to reactivate" });
    }
    const stripe = getStripe();
    await stripe.subscriptions.update(
      existingSub.stripe_subscription_id,
      { cancel_at_period_end: false }
    );
    await mutateStore((s) => {
      if (!s.subscriptions) s.subscriptions = {};
      if (s.subscriptions[user.uid]) {
        s.subscriptions[user.uid].cancel_at_period_end = false;
        s.subscriptions[user.uid].status = "active";
        s.subscriptions[user.uid].updated_at = new Date().toISOString();
      }
      return true;
    });
    return json(res, 200, {
      status: "active",
      cancel_at_period_end: false,
      message: "Pay-as-you-go reactivated.",
    });
  }

  const enablePayg = body.action === "enable_payg" || body.plan === "payg";
  const topUp = body.action === "top_up";

  if (topUp || enablePayg) {
    initFirebaseAdmin();
    const owner = await admin.auth().getUser(user.uid).catch(() => null);
    const claims = owner?.customClaims || {};

    // Already on credit wallet → top_up for more credits; enable_payg with existing balance opens portal/settings unless they want more
    if (enablePayg && isCreditWallet(claims) && Number(claims.sc_credit_balance_usd || 0) > 0 && body.force_topup !== true) {
      // Allow re-buying by treating as top-up when they pass credit_limit_usd explicitly via UI "Add credits"
      if (body.credit_limit_usd == null) {
        return startCreditCheckout(req, res, user, { ...body, action: "top_up" }, existingSub, stripeBilling);
      }
    }

    return startCreditCheckout(req, res, user, body, existingSub, stripeBilling);
  }

  return json(res, 400, { detail: "Unknown billing action" });
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});

  try {
    const user = await verifyUser(req);

    if (req.method === "GET") return handleGet(req, res, user);
    if (req.method === "POST") return handlePost(req, res, user);

    return json(res, 405, { detail: "Method not allowed", allow: "GET, POST" });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("billing error:", err);
    else console.warn("billing client error:", err.message || err);
    return json(res, status, { detail: err.message || String(err) });
  }
};
