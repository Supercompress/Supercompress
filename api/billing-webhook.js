/**
 * POST /api/billing-webhook
 * Stripe webhook handler — credit top-ups, checkout.completed, subscription.updated/deleted.
 */
const {
  getStripe,
  getPlanByPriceId,
} = require("./_lib/stripe");
const {
  applyCreditTopUp,
  persistSubscription,
} = require("./_lib/credit-topup");

module.exports.config = { api: { bodyParser: false } };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Stripe-Signature");
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { corsHeaders(res); return res.status(204).end(); }
  // Scanner GETs / missing signature — soft 200 (Vercel Observability error rate).
  if (req.method !== "POST") {
    corsHeaders(res);
    return res.status(200).json({ ok: false, probe: true, detail: "Method not allowed", allow: "POST" });
  }

  const sig = req.headers["stripe-signature"];
  if (!sig) {
    corsHeaders(res);
    return res.status(200).json({ ok: false, probe: true, detail: "Missing Stripe-Signature header" });
  }

  const webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!webhookSecret) { corsHeaders(res); return res.status(503).json({ detail: "Webhook secret not configured" }); }

  try {
    const stripe = getStripe();
    const rawBody = await readRawBody(req);
    const event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const kind = session.metadata?.kind || "";
        if (kind.startsWith("credit_")) {
          await applyCreditTopUp(session);
          break;
        }

        const userId = session.metadata?.user_id;
        const planId = session.metadata?.plan_id;
        if (userId && planId) {
          const subscriptionId = session.subscription;
          let data = {};
          if (subscriptionId) {
            const sub = await stripe.subscriptions.retrieve(subscriptionId);
            data = {
              stripe_subscription_id: sub.id,
              stripe_customer_id: session.customer,
              plan_id: planId,
              status: sub.status,
              sc_metered: planId === "payg",
              current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
              current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
              updated_at: new Date().toISOString(),
            };
          } else {
            data = {
              stripe_customer_id: session.customer,
              plan_id: planId,
              status: "active",
              updated_at: new Date().toISOString(),
            };
          }
          await persistSubscription(userId, data);
        }
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const sub = event.data.object;
        const priceId = sub.items?.data?.[0]?.price?.id;
        let planId = sub.metadata?.plan_id || getPlanByPriceId(priceId)?.id || "free";
        if (planId === "free" && priceId) {
          const mapped = getPlanByPriceId(priceId);
          if (mapped?.id && mapped.id !== "free") planId = mapped.id;
        }
        if (getPlanByPriceId(priceId)?.id === "payg") planId = "payg";
        const customer = await stripe.customers.retrieve(sub.customer);
        const userId = sub.metadata?.user_id || customer.metadata?.user_id;
        if (userId) {
          await persistSubscription(userId, {
            stripe_customer_id: sub.customer,
            stripe_subscription_id: sub.id,
            plan_id: planId,
            status: sub.status,
            sc_metered: planId === "payg",
            cancel_at_period_end: sub.cancel_at_period_end || false,
            current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
            current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const customer = await stripe.customers.retrieve(sub.customer);
        const userId = sub.metadata?.user_id || customer.metadata?.user_id;
        if (userId) {
          await persistSubscription(userId, {
            stripe_customer_id: sub.customer,
            stripe_subscription_id: sub.id,
            plan_id: "free",
            status: "canceled",
            sc_metered: false,
            updated_at: new Date().toISOString(),
          });
        }
        break;
      }
      case "payment_intent.succeeded": {
        // Auto-recharge credits balance when charged off-session (idempotent via PI id in credited list)
        const pi = event.data.object;
        if (pi.metadata?.kind === "credit_auto_recharge" && pi.metadata?.user_id) {
          const fakeSession = {
            id: `pi_${pi.id}`,
            metadata: {
              user_id: pi.metadata.user_id,
              kind: "credit_auto_recharge",
              credit_usd: pi.metadata.credit_usd,
              auto_recharge: "true",
            },
            payment_status: "paid",
            customer: pi.customer,
            payment_intent: pi.id,
            amount_total: pi.amount,
          };
          await applyCreditTopUp(fakeSession);
        }
        break;
      }
    }

    corsHeaders(res);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook error:", err);
    corsHeaders(res);
    return res.status(400).json({ detail: `Webhook Error: ${err.message}` });
  }
};
