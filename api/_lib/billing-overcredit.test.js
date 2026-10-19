/**
 * Regression: claims-fallback top-ups must credit a Checkout session exactly once,
 * even when Auth claims sit at the 1KB cap (many API keys). Previously the claims
 * trim deleted sc_credited_sessions, verify failed, and patchUserClaims re-applied
 * the credit on every retry, webhook redelivery, and dashboard reconcile.
 * Run: node api/_lib/billing-overcredit.test.js
 */
const assert = require("assert");
const Module = require("module");

// In-memory firebase-admin: Auth custom claims only (Firestore stays off by default).
const users = new Map();
const clone = (v) => JSON.parse(JSON.stringify(v));
const fakeAdmin = {
  apps: [{}],
  auth: () => ({
    getUser: async (uid) => ({ uid, customClaims: clone(users.get(uid) || {}) }),
    setCustomUserClaims: async (uid, claims) => {
      if (JSON.stringify(claims).length > 1000) throw new Error("claims too large");
      users.set(uid, clone(claims));
    },
  }),
};
// In-memory Stripe: Checkout sessions + PaymentIntents with mutable metadata.
const stripeObjs = new Map();
const stripeApi = (prefix) => ({
  retrieve: async (id) => clone(stripeObjs.get(id) || { id, metadata: {} }),
  update: async (id, { metadata }) => {
    const o = stripeObjs.get(id) || { id, metadata: {} };
    o.metadata = { ...o.metadata, ...metadata };
    stripeObjs.set(id, o);
    return clone(o);
  },
});
const fakeStripeClient = {
  checkout: { sessions: stripeApi("cs") },
  paymentIntents: stripeApi("pi"),
  customers: { update: async () => ({}), retrieve: async (id) => ({ id, metadata: {} }) },
};
function FakeStripe() {
  return fakeStripeClient; // `new Stripe(key)` returns this object
}
// Store mirror + thank-you mail are side effects outside the ledger; stub them.
const fakeStore = { mutateStore: async (fn) => fn({ subscriptions: {} }), loadStore: async () => ({}) };
const fakeThankYou = { schedulePaymentThankYou: () => {}, firstNameFromUser: () => "" };
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake";

const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === "firebase-admin") return fakeAdmin;
  if (request === "stripe") return FakeStripe;
  if (request === "./store") return fakeStore;
  if (request === "./payment-thank-you") return fakeThankYou;
  return realLoad.call(this, request, ...rest);
};
delete process.env.SUPERCOMPRESS_USE_FIRESTORE;

const {
  creditBalance,
  fitCustomClaims,
  claimsByteLength,
  AUTH_CLAIMS_MAX_BYTES,
  paidPlanOrPayg,
} = require("./billing-ledger");

const SESSION = "cs_live_TEST0000000000000000000000000000000000000000000000000000";
const UID = "uid_heavy_wallet";

// Shape of a real affected account: 8 key ids, recent billing rows, free plan.
const heavyClaims = () => ({
  sc_billing_rev: 700,
  sc_usage: { month: "2026-10", requests: 700, tokens_in: 8_600_000, tokens_out: 1_300_000, tokens_saved: 7_200_000, tokens_reported: 0 },
  sc_recent_billing: Array.from({ length: 2 }, (_, i) => ({
    i: `${i}`.repeat(40), f: "0123456789abcdef", tin: 7991, tout: 1196, ts: 6795, b: 799, t: 1791000000000,
  })),
  sc_write_id: "aaaaaaaaaaaa",
  sc_wk: "2026-w34-ship",
  sc_key_ids: Array.from({ length: 8 }, (_, i) => `sck_${String(i).repeat(24)}`),
  sc_power_mail: "sent",
  sc_power_celebrate_at: "2026-10-01T00:00:00.000Z",
  sc_customer_id: "cus_TEST00000000",
  sc_plan: "free",
});

(async () => {
  // The newest credited session survives the trim, at any claim pressure.
  {
    const fitted = fitCustomClaims({ ...heavyClaims(), sc_credited_sessions: ["cs_old_1", "cs_old_2", SESSION] });
    assert.ok(claimsByteLength(fitted) <= AUTH_CLAIMS_MAX_BYTES);
    assert.ok(fitted.sc_credited_sessions.includes(SESSION), "newest credited session must survive");
  }

  // Same $10 session replayed (webhook redeliveries + dashboard reconcile) → credited once.
  users.set(UID, heavyClaims());
  const args = { uid: UID, creditUsd: 10, creditKey: SESSION, claims: heavyClaims(), patch: { credit_limit_usd: 10 }, firstPayBonusUsd: 0.1 };
  const first = await creditBalance(args);
  assert.strictEqual(first.already, false);
  assert.strictEqual(first.balance, 10.1);
  for (let i = 0; i < 6; i++) {
    const again = await creditBalance({ ...args, claims: users.get(UID) });
    assert.strictEqual(again.already, true, `replay ${i} must be a no-op`);
  }
  const after = users.get(UID);
  assert.strictEqual(after.sc_credit_balance_usd, 10.1, "balance must be $10 + $0.10 bonus, not multiplied");
  assert.ok(after.sc_credited_sessions.includes(SESSION));
  assert.strictEqual(after.sc_plan, "payg", "top-up must enable PAYG for a free-plan account");
  assert.strictEqual(after.sc_subscription_status, "active");
  assert.ok(claimsByteLength(after) <= AUTH_CLAIMS_MAX_BYTES);

  assert.strictEqual(paidPlanOrPayg("free"), "payg");
  assert.strictEqual(paidPlanOrPayg(undefined), "payg");
  assert.strictEqual(paidPlanOrPayg("pro"), "pro");

  // Older payment replayed after a newer one pushed it out of sc_credited_sessions:
  // the live PaymentIntent stamp must block it (webhook events carry stale metadata).
  {
    const { applyCreditTopUp } = require("./credit-topup");
    const uid = "uid_two_topups";
    users.set(uid, heavyClaims());
    const mk = (n) => {
      const session = {
        id: `cs_live_TEST${n}${"0".repeat(56)}`,
        payment_intent: `pi_TEST${n}`,
        customer: "cus_TEST00000000",
        payment_status: "paid",
        status: "complete",
        amount_total: 1000,
        currency: "usd",
        created: 1791000000,
        metadata: { user_id: uid, kind: "credit_topup", credit_usd: "10", auto_recharge: "false", plan_id: "payg" },
      };
      stripeObjs.set(session.id, clone(session));
      stripeObjs.set(session.payment_intent, { id: session.payment_intent, metadata: {} });
      return session;
    };
    const a = mk("A");
    const b = mk("B");
    await applyCreditTopUp(clone(a));
    await applyCreditTopUp(clone(b));
    assert.strictEqual(stripeObjs.get(a.payment_intent).metadata.sc_credited, "true", "PI must be stamped");
    const before = users.get(uid).sc_credit_balance_usd;
    const replay = await applyCreditTopUp(clone(a)); // stale event metadata, no sc_credited
    assert.strictEqual(replay.already, true, "replayed older session must be a no-op");
    assert.strictEqual(users.get(uid).sc_credit_balance_usd, before);
    assert.strictEqual(before, 20.1, "two $10 top-ups + one $0.10 first-pay bonus");
  }

  console.log("billing-overcredit.test.js: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
