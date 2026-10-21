const assert = require("node:assert/strict");
const test = require("node:test");
const { createFunnelTracker, summarizeFunnel, markerId } = require("./billing-funnel");

function fixture() {
  const users = new Map();
  let date = new Date("2026-10-19T23:00:00Z");
  const auth = {
    async getUser(uid) {
      if (!users.has(uid)) throw Object.assign(new Error(), { code: "auth/user-not-found" });
      return users.get(uid);
    },
    async createUser(user) {
      if (users.has(user.uid)) throw Object.assign(new Error(), { code: "auth/uid-already-exists" });
      const record = { ...user, metadata: { creationTime: date.toISOString() } };
      users.set(user.uid, record);
      return record;
    },
    async setCustomUserClaims(uid, claims) {
      users.get(uid).customClaims = claims;
    },
  };
  const options = { getAuth: () => auth, now: () => date, warn: () => {} };
  return { users, auth, options, nextMonth: () => { date = new Date("2026-11-01T00:00:00Z"); } };
}

test("monthly markers survive cold starts, concurrent retries, and month changes without Firestore", async () => {
  const { users, options, nextMonth } = fixture();
  const tracker = createFunnelTracker(options);
  assert.deepEqual(await Promise.all([
    tracker.record("owner", "quota_blocked"),
    tracker.record("owner", "quota_blocked"),
    createFunnelTracker(options).record("owner", "quota_blocked"),
  ]), [true, true, true]);
  assert.equal(users.size, 1);
  const cold = createFunnelTracker(options);
  assert.equal((await cold.read("owner", "quota_blocked")).uid, "owner");
  assert.equal(await cold.record("owner", "quota_blocked"), true);
  assert.equal(users.size, 1);
  nextMonth();
  assert.equal(await cold.read("owner", "quota_blocked"), null);
  await cold.record("owner", "quota_blocked");
  assert.equal(users.size, 2);
  assert.ok([...users.values()].every((user) => user.disabled && !user.email));
});

test("stages count unique owners, with an explicitly unordered blocked cohort", async () => {
  const { users, options } = fixture();
  const tracker = createFunnelTracker(options);
  for (const stage of ["quota_blocked", "billing_opened", "checkout_created", "payment_succeeded"]) {
    await tracker.record("owner", stage);
  }
  await tracker.record("other", "billing_opened");
  const summary = summarizeFunnel([...users.values()], "2026-10");
  assert.equal(summary.unique_accounts.billing_opened, 2);
  assert.equal(summary.blocked_cohort.billing_opened, 1);
  assert.equal(summary.unique_accounts.payment_succeeded, 1);
  assert.equal(summarizeFunnel([...users.values()], "2026-11").unique_accounts.quota_blocked, 0);
});

test("invalid stages and unavailable persistence do not break billing", async () => {
  const tracker = createFunnelTracker({ getAuth() { throw new Error("offline"); }, warn() {} });
  assert.equal(await tracker.record("owner", "arbitrary_event"), false);
  assert.equal(await tracker.record("owner", "quota_blocked"), false);
  assert.equal(await tracker.read("owner", "quota_blocked"), null);
  assert.equal(await tracker.record("", "quota_blocked"), false);
});

test("telemetry timeout is bounded and does not throw", async () => {
  const tracker = createFunnelTracker({
    getAuth: () => ({ getUser: () => new Promise(() => {}) }), warn() {}, timeoutMs: 10,
  });
  assert.equal(await tracker.record("owner", "quota_blocked"), false);
  assert.equal(await tracker.read("owner", "quota_blocked"), null);
});

test("incomplete markers are repaired without overwriting the owner's claims", async () => {
  const { users, options } = fixture();
  const id = markerId("owner", "2026-10", "quota_blocked");
  users.set(id, { uid: id, disabled: true, metadata: { creationTime: "2026-10-19" } });
  users.set("owner", { uid: "owner", customClaims: { sc_credit_balance_usd: 10 } });
  const tracker = createFunnelTracker(options);
  assert.equal(await tracker.record("owner", "quota_blocked"), true);
  assert.equal((await tracker.read("owner", "quota_blocked")).stage, "quota_blocked");
  assert.deepEqual(users.get("owner").customClaims, { sc_credit_balance_usd: 10 });
});

test("paid webhook retries retain the actual success month, not the retry month", async () => {
  const { users, options } = fixture();
  const tracker = createFunnelTracker(options);
  const paid = { payment_status: "paid", amount_total: 1000, metadata: { user_id: "owner", kind: "credit_topup" } };
  const created = Date.parse("2026-09-30T23:59:59Z") / 1000;
  assert.equal(await tracker.recordPayment(paid, created), true);
  assert.equal(await createFunnelTracker(options).recordPayment(paid, created), true);
  assert.equal(summarizeFunnel([...users.values()], "2026-10").unique_accounts.payment_succeeded, 0);
  assert.equal(summarizeFunnel([...users.values()], "2026-09").unique_accounts.payment_succeeded, 1);
  for (const invalid of [{ payment_status: "unpaid" }, { amount_total: 0 }, { amount_total: undefined }]) {
    assert.equal(await tracker.recordPayment({ ...paid, ...invalid }, created), false);
  }
  assert.equal(await tracker.recordPayment(paid), false);
});
