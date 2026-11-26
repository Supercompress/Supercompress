/**
 * New-customer offer: 50% off the first credit pack, paid as a one-time bonus that matches
 * the first payment (capped). Pure eligibility rules plus the real applyCreditTopUp path
 * against in-memory Firebase Auth and Stripe.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const users = new Map();
const clone = (v) => JSON.parse(JSON.stringify(v));
const fakeAdmin = {
  apps: [{}],
  auth: () => ({
    getUser: async (uid) => {
      const u = users.get(uid) || { claims: {}, created: new Date().toISOString() };
      return { uid, customClaims: clone(u.claims), metadata: { creationTime: u.created } };
    },
    setCustomUserClaims: async (uid, claims) => {
      const u = users.get(uid) || { claims: {}, created: new Date().toISOString() };
      users.set(uid, { ...u, claims: clone(claims) });
    },
  }),
};
const stripeObjs = new Map();
const stripeApi = () => ({
  retrieve: async (id) => clone(stripeObjs.get(id) || { id, metadata: {} }),
  update: async (id, { metadata }) => {
    const o = stripeObjs.get(id) || { id, metadata: {} };
    o.metadata = { ...o.metadata, ...metadata };
    stripeObjs.set(id, o);
    return clone(o);
  },
});
const fakeStripeClient = {
  checkout: { sessions: stripeApi() },
  paymentIntents: stripeApi(),
  customers: { update: async () => ({}), retrieve: async (id) => ({ id, metadata: {} }) },
};
function FakeStripe() {
  return fakeStripeClient;
}
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake";
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === "firebase-admin") return fakeAdmin;
  if (request === "stripe") return FakeStripe;
  if (request === "./store") return { mutateStore: async (fn) => fn({ subscriptions: {} }), loadStore: async () => ({}) };
  if (request === "./payment-thank-you") return { schedulePaymentThankYou: () => {}, firstNameFromUser: () => "" };
  return realLoad.call(this, request, ...rest);
};
delete process.env.SUPERCOMPRESS_USE_FIRESTORE;

const { newCustomerOffer, newCustomerBonusUsd, MAX_BONUS_USD } = require("./new-customer-offer");
const { applyCreditTopUp } = require("./credit-topup");

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-11-25T12:00:00Z");
const owner = (daysOld, claims = {}) => ({ customClaims: claims, metadata: { creationTime: new Date(now - daysOld * DAY).toISOString() } });

test("eligible within 7 days of signup, before any purchase", () => {
  const offer = newCustomerOffer(owner(2), { at: now, env: {} });
  assert.equal(offer.eligible, true);
  assert.equal(offer.percent_off, 50);
  assert.equal(offer.expires_at, new Date(now - 2 * DAY + 7 * DAY).toISOString());
});

test("not eligible after the window, after a purchase, when comped or switched off", () => {
  assert.equal(newCustomerOffer(owner(8), { at: now, env: {} }).reason, "expired");
  assert.equal(newCustomerOffer(owner(1, { sc_credited_sessions: ["cs_1"] }), { at: now, env: {} }).reason, "already_purchased");
  assert.equal(newCustomerOffer(owner(1, { sc_first_pay_bonus_at: "2026-10-01" }), { at: now, env: {} }).reason, "already_purchased");
  assert.equal(newCustomerOffer(owner(1, { sc_comped: true }), { at: now, env: {} }).reason, "comped");
  assert.equal(newCustomerOffer(owner(1), { at: now, env: { SC_NEW_CUSTOMER_OFFER: "0" } }).reason, "disabled");
  assert.equal(newCustomerOffer({ customClaims: {} }, { at: now, env: {} }).reason, "unknown_signup_date");
});

test("bonus matches the payment up to the cap", () => {
  const offer = { eligible: true };
  assert.equal(newCustomerBonusUsd(10, offer), 10);
  assert.equal(newCustomerBonusUsd(100, offer), MAX_BONUS_USD);
  assert.equal(newCustomerBonusUsd(10, { eligible: false }), 0);
  assert.equal(newCustomerBonusUsd(-5, offer), 0);
});

function session(id, uid, usd, startedMs) {
  const s = {
    id,
    status: "complete",
    payment_status: "paid",
    amount_total: Math.round(usd * 100),
    customer: "cus_offer",
    created: Math.floor(startedMs / 1000),
    metadata: { user_id: uid, kind: "credit_topup", credit_usd: String(usd), auto_recharge: "false" },
  };
  stripeObjs.set(id, clone(s));
  return s;
}

test("a new customer's first $10 pack credits $20; the second pack gets no bonus", async () => {
  users.set("uid_new", { claims: {}, created: new Date(Date.now() - 1 * DAY).toISOString() });
  const first = await applyCreditTopUp(session("cs_offer_first", "uid_new", 10, Date.now()));
  assert.equal(first.applied, true);
  let claims = users.get("uid_new").claims;
  assert.equal(Number(claims.sc_credit_balance_usd), 20);
  assert.equal(Number(claims.sc_first_pay_bonus_usd), 10);

  // Redelivery of the same session credits nothing more.
  await applyCreditTopUp(session("cs_offer_first", "uid_new", 10, Date.now()));
  assert.equal(Number(users.get("uid_new").claims.sc_credit_balance_usd), 20);

  await applyCreditTopUp(session("cs_offer_second", "uid_new", 10, Date.now()));
  claims = users.get("uid_new").claims;
  assert.equal(Number(claims.sc_credit_balance_usd), 30);
});

test("a $100 first pack gets the $50 cap; an account older than 7 days gets nothing", async () => {
  users.set("uid_big", { claims: {}, created: new Date(Date.now() - 3 * DAY).toISOString() });
  await applyCreditTopUp(session("cs_offer_big", "uid_big", 100, Date.now()));
  assert.equal(Number(users.get("uid_big").claims.sc_credit_balance_usd), 150);

  users.set("uid_old", { claims: {}, created: new Date(Date.now() - 30 * DAY).toISOString() });
  await applyCreditTopUp(session("cs_offer_old", "uid_old", 10, Date.now()));
  assert.equal(Number(users.get("uid_old").claims.sc_credit_balance_usd), 10);
});

test("the window is judged when checkout started, not when the webhook lands", async () => {
  const created = Date.now() - 7 * DAY + 60_000; // one minute of window left at checkout start
  users.set("uid_edge", { claims: {}, created: new Date(created).toISOString() });
  await applyCreditTopUp(session("cs_offer_edge", "uid_edge", 10, Date.now() - 30_000));
  assert.equal(Number(users.get("uid_edge").claims.sc_credit_balance_usd), 20);
});
