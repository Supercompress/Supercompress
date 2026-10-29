const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");
const { reconciledMailSuppressions } = require("./mail-suppressions");

function harness({ stamp = true, authReady = true, lookupError, storeError } = {}) {
  const stored = {};
  const claims = {};
  const context = {
    module: { exports: {} }, process, console: { warn() {} }, Buffer,
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
        getUserByEmail: async () => {
          if (lookupError) throw lookupError;
          return { uid: "recipient" };
        },
      }) };
      if (name === "./mail" || name === "./welcome") return {};
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("./weekly"), "utf8"), context);
  return { weekly: context.module.exports, claims, stored };
}

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
