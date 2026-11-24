/**
 * Stripe webhook handler: signature gate, body cap, and how each event type
 * credits wallets or persists plans. Uses the real Stripe SDK for signing so
 * verification is exercised end to end; credit/plan persistence is stubbed.
 * Run: node api/billing-webhook.test.js
 */
const assert = require("assert");
const { EventEmitter } = require("events");
const Module = require("module");

const WEBHOOK_SECRET = "whsec_test_secret";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_PRICE_PAYG = "price_payg_test";

const calls = { topUps: [], subs: [] };
// The handler destructures at require time, so tests swap `impl` instead of the export.
const impl = {
  applyCreditTopUp: async (session) => {
    calls.topUps.push(session);
  },
};
const fakeCreditTopUp = {
  applyCreditTopUp: (session) => impl.applyCreditTopUp(session),
  persistSubscription: async (userId, data) => {
    calls.subs.push({ userId, data });
  },
};

const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === "./_lib/credit-topup") return fakeCreditTopUp;
  return realLoad.call(this, request, ...rest);
};

const handler = require("./billing-webhook");
const { getStripe, PLANS } = require("./_lib/stripe");

// Real SDK client for signing/verification; network reads are replaced below.
const stripe = getStripe();
const stripeObjects = {
  sub_123: { id: "sub_123", status: "active", current_period_start: 1700000000, current_period_end: 1702592000 },
  cus_meta: { id: "cus_meta", metadata: { user_id: "uid_from_customer" } },
  cus_none: { id: "cus_none", metadata: {} },
};
stripe.subscriptions.retrieve = async (id) => stripeObjects[id];
stripe.customers.retrieve = async (id) => stripeObjects[id] || { id, metadata: {} };

function makeReq({ method = "POST", headers = {}, body = "" } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  req.destroy = () => {
    req.destroyed = true;
  };
  setImmediate(() => {
    const chunks = Array.isArray(body) ? body : [Buffer.from(body)];
    for (const c of chunks) {
      if (req.destroyed) return;
      req.emit("data", c);
    }
    req.emit("end");
  });
  return req;
}

function makeRes() {
  const res = { statusCode: null, body: undefined, ended: false };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  res.end = () => {
    res.ended = true;
    return res;
  };
  return res;
}

function signedReq(event, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return makeReq({ headers: { "stripe-signature": header }, body: payload });
}

function evt(type, object) {
  return { id: `evt_${type}`, object: "event", type, data: { object } };
}

async function send(req) {
  const res = makeRes();
  await handler(req, res);
  return res;
}

function reset() {
  calls.topUps.length = 0;
  calls.subs.length = 0;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("OPTIONS returns 204 and non-POST is a soft probe", async () => {
  const opt = await send(makeReq({ method: "OPTIONS" }));
  assert.strictEqual(opt.statusCode, 204);
  const get = await send(makeReq({ method: "GET" }));
  assert.strictEqual(get.statusCode, 200);
  assert.deepStrictEqual(get.body.probe, true);
  assert.strictEqual(calls.topUps.length + calls.subs.length, 0);
});

test("missing Stripe-Signature never processes the event", async () => {
  const res = await send(
    makeReq({ body: JSON.stringify(evt("checkout.session.completed", { metadata: { kind: "credit_topup" } })) })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.probe, true);
  assert.strictEqual(calls.topUps.length, 0);
});

test("unconfigured webhook secret fails closed with 503", async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  try {
    const res = await send(signedReq(evt("checkout.session.completed", { metadata: { kind: "credit_topup" } })));
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(calls.topUps.length, 0);
  } finally {
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  }
});

test("forged signature (wrong secret) is rejected with 400 and no credit", async () => {
  const res = await send(
    signedReq(evt("checkout.session.completed", { metadata: { kind: "credit_topup", user_id: "u1" } }), "whsec_attacker")
  );
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.body, { detail: "Invalid webhook" });
  assert.strictEqual(calls.topUps.length, 0);
});

test("payload tampered after signing is rejected", async () => {
  const payload = JSON.stringify(evt("checkout.session.completed", { amount_total: 1000, metadata: { kind: "credit_topup" } }));
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const tampered = payload.replace("1000", "9999999");
  const res = await send(makeReq({ headers: { "stripe-signature": header }, body: tampered }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(calls.topUps.length, 0);
});

test("bodies over 1 MiB are refused with 413", async () => {
  const chunk = Buffer.alloc(512 * 1024, 0x61);
  const req = makeReq({ headers: { "stripe-signature": "t=1,v1=x" }, body: [chunk, chunk, chunk] });
  const res = await send(req);
  assert.strictEqual(res.statusCode, 413);
  assert.strictEqual(req.destroyed, true);
});

test("credit_* checkout applies a top-up and never touches the plan", async () => {
  const session = { id: "cs_1", amount_total: 2500, metadata: { kind: "credit_topup", user_id: "u1", plan_id: "payg" } };
  const res = await send(signedReq(evt("checkout.session.completed", session)));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { received: true });
  assert.strictEqual(calls.topUps.length, 1);
  assert.strictEqual(calls.topUps[0].id, "cs_1");
  assert.strictEqual(calls.subs.length, 0);
});

test("async_payment_succeeded checkout also credits", async () => {
  await send(signedReq(evt("checkout.session.async_payment_succeeded", { id: "cs_2", metadata: { kind: "credit_topup" } })));
  assert.strictEqual(calls.topUps.length, 1);
});

test("subscription checkout persists the subscription period and metering flag", async () => {
  const session = { id: "cs_3", customer: "cus_1", subscription: "sub_123", metadata: { user_id: "u1", plan_id: "payg" } };
  const res = await send(signedReq(evt("checkout.session.completed", session)));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.subs.length, 1);
  const { userId, data } = calls.subs[0];
  assert.strictEqual(userId, "u1");
  assert.strictEqual(data.stripe_subscription_id, "sub_123");
  assert.strictEqual(data.stripe_customer_id, "cus_1");
  assert.strictEqual(data.plan_id, "payg");
  assert.strictEqual(data.sc_metered, true);
  assert.strictEqual(data.status, "active");
  assert.strictEqual(data.current_period_start, new Date(1700000000 * 1000).toISOString());
  assert.strictEqual(data.current_period_end, new Date(1702592000 * 1000).toISOString());
});

test("checkout without user_id/plan_id persists nothing", async () => {
  await send(signedReq(evt("checkout.session.completed", { id: "cs_4", customer: "cus_1", metadata: {} })));
  assert.strictEqual(calls.subs.length + calls.topUps.length, 0);
});

test("subscription.updated maps the price id to a plan and resolves the user from the customer", async () => {
  const sub = {
    id: "sub_9",
    customer: "cus_meta",
    status: "active",
    cancel_at_period_end: true,
    current_period_start: 1700000000,
    current_period_end: 1702592000,
    metadata: {},
    items: { data: [{ price: { id: PLANS.pro.price_id } }] },
  };
  await send(signedReq(evt("customer.subscription.updated", sub)));
  assert.strictEqual(calls.subs.length, 1);
  assert.strictEqual(calls.subs[0].userId, "uid_from_customer");
  assert.strictEqual(calls.subs[0].data.plan_id, "pro");
  assert.strictEqual(calls.subs[0].data.sc_metered, false);
  assert.strictEqual(calls.subs[0].data.cancel_at_period_end, true);
});

test("PAYG price forces the payg plan even when metadata names another plan", async () => {
  const sub = {
    id: "sub_10",
    customer: "cus_none",
    status: "active",
    current_period_start: 1700000000,
    current_period_end: 1702592000,
    metadata: { user_id: "u2", plan_id: "starter" },
    items: { data: [{ price: { id: "price_payg_test" } }] },
  };
  await send(signedReq(evt("customer.subscription.created", sub)));
  assert.strictEqual(calls.subs[0].userId, "u2");
  assert.strictEqual(calls.subs[0].data.plan_id, "payg");
  assert.strictEqual(calls.subs[0].data.sc_metered, true);
});

test("subscription event with no resolvable user persists nothing", async () => {
  const sub = {
    id: "sub_11",
    customer: "cus_none",
    status: "active",
    current_period_start: 1,
    current_period_end: 2,
    metadata: {},
    items: { data: [{ price: { id: PLANS.pro.price_id } }] },
  };
  await send(signedReq(evt("customer.subscription.updated", sub)));
  assert.strictEqual(calls.subs.length, 0);
});

test("subscription.deleted downgrades the user to free and cancels metering", async () => {
  await send(signedReq(evt("customer.subscription.deleted", { id: "sub_12", customer: "cus_meta", metadata: {} })));
  assert.strictEqual(calls.subs.length, 1);
  assert.strictEqual(calls.subs[0].userId, "uid_from_customer");
  assert.deepStrictEqual(
    { plan_id: calls.subs[0].data.plan_id, status: calls.subs[0].data.status, sc_metered: calls.subs[0].data.sc_metered },
    { plan_id: "free", status: "canceled", sc_metered: false }
  );
});

test("auto-recharge payment_intent credits the charged amount, not metadata credit_usd", async () => {
  const pi = {
    id: "pi_77",
    amount: 1500,
    customer: "cus_meta",
    metadata: { kind: "credit_auto_recharge", user_id: "u3", credit_usd: "999" },
  };
  await send(signedReq(evt("payment_intent.succeeded", pi)));
  assert.strictEqual(calls.topUps.length, 1);
  const s = calls.topUps[0];
  assert.strictEqual(s.id, "pi_pi_77");
  assert.strictEqual(s.amount_total, 1500);
  assert.strictEqual(s.payment_status, "paid");
  assert.strictEqual(s.payment_intent, "pi_77");
  assert.strictEqual(s.metadata.user_id, "u3");
  assert.strictEqual(s.metadata.kind, "credit_auto_recharge");
});

test("already-credited or unrelated payment_intents are ignored", async () => {
  await send(
    signedReq(evt("payment_intent.succeeded", { id: "pi_1", amount: 1500, metadata: { kind: "credit_auto_recharge", user_id: "u3", sc_credited: "true" } }))
  );
  await send(signedReq(evt("payment_intent.succeeded", { id: "pi_2", amount: 1500, metadata: { kind: "other", user_id: "u3" } })));
  await send(signedReq(evt("payment_intent.succeeded", { id: "pi_3", amount: 1500, metadata: { kind: "credit_auto_recharge" } })));
  assert.strictEqual(calls.topUps.length, 0);
});

test("unknown event types are acknowledged without side effects", async () => {
  const res = await send(signedReq(evt("invoice.paid", { id: "in_1" })));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.topUps.length + calls.subs.length, 0);
});

test("processing failures return a generic 500 so Stripe retries, without leaking internals", async () => {
  const orig = impl.applyCreditTopUp;
  impl.applyCreditTopUp = async () => {
    throw new Error("firestore exploded: projects/secret-internal");
  };
  const origErr = console.error;
  console.error = () => {};
  try {
    const res = await send(signedReq(evt("checkout.session.completed", { id: "cs_x", metadata: { kind: "credit_topup" } })));
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(res.body, { detail: "Webhook processing failed" });
  } finally {
    impl.applyCreditTopUp = orig;
    console.error = origErr;
  }
});

(async () => {
  const origErr = console.error;
  let failed = 0;
  for (const t of tests) {
    reset();
    console.error = () => {}; // handler logs expected signature failures
    try {
      await t.fn();
      console.error = origErr;
      console.log(`ok - ${t.name}`);
    } catch (err) {
      console.error = origErr;
      failed++;
      console.error(`FAIL - ${t.name}\n`, err);
    }
  }
  Module._load = realLoad;
  if (failed) {
    console.error(`${failed} billing-webhook test(s) failed`);
    process.exit(1);
  }
  console.log(`billing-webhook: ${tests.length} tests passed`);
})();
