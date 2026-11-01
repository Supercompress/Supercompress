const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");
const { reconciledMailSuppressions } = require("./mail-suppressions");

function harness({ stamp = true, authReady = true, lookupError, storeError, initialStore = {}, disabled = false, liveEmail = "recipient@product.example.test" } = {}) {
  const stored = initialStore;
  const claims = {};
  const messages = [];
  const context = {
    module: { exports: {} }, process: { env: { RESEND_API_KEY: "offline-fixture" } }, console: { warn() {} }, Buffer,
    require(name) {
      if (name === "./store") return {
        loadStore: async () => stored,
        mutateStore: async mutate => {
          if (storeError) throw storeError;
          return mutate(stored);
        },
      };
      if (name === "./auth") return { initFirebaseAdmin: () => authReady };
      if (name === "./billing-ledger") return {
        stampOwnerClaim: async (uid, field, value) => {
          if (stamp) claims[field] = value;
          return stamp;
        },
      };
      if (name === "firebase-admin") return { auth: () => ({
        getUser: async uid => {
          assert.equal(uid, "recipient");
          if (lookupError) throw lookupError;
          return { uid, email: liveEmail, customClaims: claims, disabled };
        },
        getUserByEmail: async () => {
          if (lookupError) throw lookupError;
          return { uid: "recipient", customClaims: claims, disabled };
        },
      }) };
      if (name === "./mail") return { sendWeeklyEmail: async message => { messages.push(message); return { ok: true }; } };
      if (name === "./welcome") return {};
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("./weekly"), "utf8"), context);
  return { weekly: context.module.exports, claims, stored, messages };
}

test("queued weekly delivery checks an Auth-only unsubscribe even after the store recovers", async () => {
  const initialStore = { weekly_emails: { queued: { key: "queued", uid: "recipient", email: "recipient@product.example.test", status: "pending" } } };
  const failedStore = harness({ storeError: Error("offline"), initialStore });
  await failedStore.weekly.unsubscribeEmail("recipient@product.example.test", null, { confirmOnly: true });
  const recovered = harness({ initialStore });
  Object.assign(recovered.claims, failedStore.claims);
  const result = await recovered.weekly.drainPendingWeekly();
  assert.equal(result.sent, 0);
  assert.equal(recovered.messages.length, 0);
  assert.equal(initialStore.weekly_emails.queued.status, "unsubscribed");
});

test("queued weekly delivery fails closed for unavailable Auth and missing or disabled users", async () => {
  for (const options of [
    { authReady: false }, { lookupError: Error("transient") },
    { lookupError: Object.assign(Error("missing"), { code: "auth/user-not-found" }) }, { disabled: true },
  ]) {
    const initialStore = { weekly_emails: { queued: { key: "queued", uid: "recipient", email: "recipient@product.example.test", status: "pending" } } };
    const fixture = harness({ ...options, initialStore });
    await fixture.weekly.drainPendingWeekly();
    assert.equal(fixture.messages.length, 0);
  }
});

test("queued weekly delivery still sends to a confirmed subscribed user", async () => {
  const initialStore = { weekly_emails: { queued: { key: "queued", uid: "recipient", email: "recipient@product.example.test", status: "pending" } } };
  const fixture = harness({ initialStore });
  const result = await fixture.weekly.drainPendingWeekly();
  assert.equal(result.sent, 1);
  assert.equal(initialStore.weekly_emails.queued.status, "sent");
});

test("weekly queue suppresses changed emails, missing identity, and deleted original accounts", async () => {
  for (const options of [
    { liveEmail: "changed@product.example.test" },
    { missingUid: true },
    { lookupError: Object.assign(Error("original user deleted"), { code: "auth/user-not-found" }) },
  ]) {
    const rec = { key: "queued", uid: "recipient", email: "recipient@product.example.test", status: "pending" };
    if (options.missingUid) delete rec.uid;
    const fixture = harness({ ...options, initialStore: { weekly_emails: { queued: rec } } });
    await fixture.weekly.drainPendingWeekly();
    assert.equal(fixture.messages.length, 0);
    assert.equal(fixture.stored.weekly_emails.queued.status, "suppressed");
  }
});

test("production recipient block predicate is exported and callable", () => {
  const { weekly } = harness();
  assert.equal(typeof weekly.isHardBlockedRecipient, "function");
  assert.equal(weekly.isHardBlockedRecipient({ email: "saurabh@product.example.test" }), true);
});

test("successful unsubscribe stamps the Auth flag used by conversion suppression", async () => {
  const { weekly, claims } = harness({ storeError: Error("store offline") });
  assert.equal((await weekly.unsubscribeEmail("recipient@product.example.test", null, { confirmOnly: true })).ok, true);
  assert.equal(claims.sc_unsub, "1");
});

test("a false Auth stamp cannot acknowledge success even when the store succeeds", async () => {
  const { weekly, stored } = harness({ stamp: false });
  await assert.rejects(weekly.unsubscribeEmail("recipient@product.example.test", null, { confirmOnly: true }), { status: 503 });
  assert.ok(stored.weekly_unsubscribes["recipient@product.example.test"]);
});

test("unavailable Auth and transient lookups cannot masquerade as missing accounts", async () => {
  for (const options of [{ authReady: false }, { lookupError: Error("network") }]) {
    const { weekly } = harness(options);
    await assert.rejects(weekly.unsubscribeEmail("recipient@product.example.test", null, { confirmOnly: true }), { status: 503 });
  }
});

test("a genuinely absent Auth account requires a successful durable store write", async () => {
  const lookupError = Object.assign(Error("missing"), { code: "auth/user-not-found" });
  const { weekly } = harness({ lookupError });
  assert.equal((await weekly.unsubscribeEmail("recipient@product.example.test", null, { confirmOnly: true })).ok, true);
  const failed = harness({ lookupError, storeError: Error("offline") });
  await assert.rejects(failed.weekly.unsubscribeEmail("recipient@product.example.test", null, { confirmOnly: true }), { status: 503 });
});

test("reconciled suppression manifests fail closed and preserve known hashes", () => {
  assert.throws(() => reconciledMailSuppressions({}), /suppression_reconciliation_missing/);
  assert.throws(() => reconciledMailSuppressions({ SC_MAIL_SUPPRESSIONS_RECONCILED_AT: "2026-10-29", SC_MAIL_SUPPRESSION_SHA256: '["invalid"]' }), /invalid_suppression_manifest/);
  const hash = "a".repeat(64);
  assert.ok(reconciledMailSuppressions({ SC_MAIL_SUPPRESSIONS_RECONCILED_AT: "2026-10-29", SC_MAIL_SUPPRESSION_SHA256: JSON.stringify([hash]) }).has(hash));
});
