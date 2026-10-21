const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { Readable } = require("node:stream");
const Stripe = require("stripe");

function handler({ signedIn = true, checkoutFails = false } = {}) {
  const stages = [];
  const customer = { id: "cus_offline", metadata: { user_id: "verified_owner" } };
  const loaded = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "billing.js"), "utf8"), {
    module: loaded,
    require(name) {
      if (name === "./_lib/auth") return {
        verifyUser: async () => {
          if (!signedIn) throw Object.assign(new Error("Unauthorized"), { status: 401 });
          return { uid: "verified_owner" };
        },
        initFirebaseAdmin: () => true,
      };
      if (name === "firebase-admin") return { auth: () => ({ getUser: async () => ({ customClaims: {} }) }) };
      if (name === "./_lib/http") return { json(res, status, body) { res.status = status; res.body = body; } };
      if (name === "./_lib/billing-funnel") return { record: async (...args) => { stages.push(args); return true; } };
      if (name === "./_lib/billing-ledger") return { patchUserClaims: async () => {} };
      if (name === "./_lib/store") return {
        loadStore: async () => ({ subscriptions: { verified_owner: { stripe_customer_id: customer.id } } }),
        mutateStore: async () => {},
      };
      if (name === "./_lib/stripe") return {
        normalizeCreditLimitUsd: () => 10,
        isCreditWallet: () => false,
        getStripe: () => ({
          customers: { search: async () => ({ data: [customer] }) },
          subscriptions: { list: async () => ({ data: [] }) },
        }),
        createCreditTopUpCheckout: async () => {
          if (checkoutFails) throw new Error("Stripe offline");
          return { session: { id: "cs_offline", url: "https://checkout.stripe.com/offline" }, amount: 10 };
        },
      };
      if (["./_lib/credit-topup", "./_lib/billing-access", "./_lib/subscription-period"].includes(name)) return {};
      throw new Error(`Unexpected dependency ${name}`);
    },
    console: { warn() {}, error() {} },
  });
  return { run: loaded.exports, stages };
}

test("billing view tracking uses verified identity, never submitted UID or arbitrary stage", async () => {
  const { run, stages } = handler();
  const response = {};
  await run({ method: "POST", body: { action: "billing_opened", uid: "victim", stage: "payment_succeeded" } }, response);
  assert.equal(response.status, 200);
  assert.deepEqual(stages, [["verified_owner", "billing_opened"]]);
});

test("unauthenticated tracking is rejected without recording anything", async () => {
  const { run, stages } = handler({ signedIn: false });
  const response = {};
  await run({ method: "POST", body: { action: "billing_opened" } }, response);
  assert.equal(response.status, 401);
  assert.equal(stages.length, 0);
});

test("checkout stage is only recorded after Stripe creates a session", async () => {
  for (const checkoutFails of [false, true]) {
    const { run, stages } = handler({ checkoutFails });
    const response = {};
    await run({ method: "POST", body: { action: "top_up" } }, response);
    assert.equal(response.status, checkoutFails ? 500 : 200);
    assert.deepEqual(stages, checkoutFails ? [] : [["verified_owner", "checkout_created"]]);
  }
});

test("reconciling or replaying an old paid session never records a current-month payment", async () => {
  const stages = [];
  const loaded = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "_lib/credit-topup.js"), "utf8"), {
    module: loaded,
    require(name) {
      if (name === "./stripe") return { TOKENS_PER_BILLING_UNIT: 1000000, tokensToUsd: () => 0.1 };
      if (name === "./credit-amount") return {
        paidCreditUsdFromSession: (session) => session.amount_total / 100,
        isCreditablePaidUsd: (amount) => Number.isFinite(amount) && amount > 0,
      };
      if (name === "./auth") return { initFirebaseAdmin: () => false };
      if (name === "./billing-funnel") return { record: async (...args) => { stages.push(args); } };
      if (["./store", "firebase-admin"].includes(name)) return {};
      throw new Error(`Unexpected dependency ${name}`);
    },
    console,
  });
  const base = { metadata: { user_id: "owner", kind: "credit_topup" }, status: "complete" };
  for (const extra of [
    { payment_status: "unpaid", amount_total: 1000 },
    { payment_status: "paid", amount_total: 0 },
    { amount_total: 1000 },
    { payment_status: "paid" },
  ]) {
    await loaded.exports.applyCreditTopUp({ ...base, ...extra });
  }
  assert.equal(stages.length, 0);
  await loaded.exports.applyCreditTopUp({ ...base, payment_status: "paid", amount_total: 1000 });
  await loaded.exports.applyCreditTopUp({ ...base, payment_status: "paid", amount_total: 1000, metadata: { ...base.metadata, sc_credited: "true" } });
  assert.deepEqual(stages, []);
});

test("payment telemetry receives signed event time, including an already credited recharge", async () => {
  const stripe = new Stripe("sk_test_offline");
  const secret = "whsec_offline_funnel_test";
  for (const type of ["checkout.session.completed", "payment_intent.succeeded"]) {
    for (const validSignature of [true, false]) {
      const calls = [];
      const loaded = { exports: {} };
      const object = type.startsWith("checkout")
        ? { payment_status: "paid", amount_total: 1000, metadata: { user_id: "owner", kind: "credit_topup" } }
        : { amount: 1000, metadata: { user_id: "owner", kind: "credit_auto_recharge", sc_credited: "true" } };
      const created = Date.parse("2026-09-30T23:59:59Z") / 1000;
      const payload = JSON.stringify({ type, created, data: { object } });
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, "billing-webhook.js"), "utf8"), {
        module: loaded,
        require(name) {
          if (name === "./_lib/stripe") return { getStripe: () => stripe };
          if (name === "./_lib/credit-topup") return { applyCreditTopUp: async () => ({ applied: true, already: true }) };
          if (name === "./_lib/billing-funnel") return { recordPayment: async (...args) => { calls.push(args); } };
          if (name === "./_lib/subscription-period") return {};
          throw new Error(`Unexpected dependency ${name}`);
        },
        process: { env: { STRIPE_WEBHOOK_SECRET: secret } }, Buffer, console: { error() {} },
      });
      const request = Readable.from([Buffer.from(payload)]);
      request.method = "POST";
      request.headers = { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: validSignature ? secret : "whsec_invalid" }) };
      const response = { status(code) { this.code = code; return this; }, json() { return this; } };
      await loaded.exports(request, response);
      assert.equal(calls.length, validSignature ? 1 : 0);
      if (validSignature) assert.equal(calls[0][1], created);
    }
  }
});
