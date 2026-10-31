const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");

test("production power-quota adapter suppresses blocked names in email and display name", async () => {
  const users = [
    { uid: "blocked-email", email: "nikunjxyz@product.example.test" },
    { uid: "blocked-name", email: "recipient@product.example.test", displayName: "Alex Kothari" },
    { uid: "allowed", email: "allowed@product.example.test" },
  ].map(user => ({ ...user, customClaims: { sc_power_mail: "sent" } }));
  const messages = [];
  const context = { module: { exports: {} }, require(name) {
    if (name === "firebase-admin") return { auth: () => ({ listUsers: async () => ({ users }), getUser: async uid => users.find(user => user.uid === uid) }) };
    if (name === "./auth") return { initFirebaseAdmin: () => true };
    if (name === "./billing-ledger") return { stampOwnerClaim: async () => true };
    if (name === "./mail-suppressions") return { reconciledMailSuppressions: () => new Set() };
    if (name === "./weekly") return { isHardBlockedRecipient: () => false, unsubUrlFor: () => "offline", unsubApiUrlFor: () => "offline" };
    if (name === "./mail") return { sendQuotaExhaustedEmail: async message => { messages.push(message); return { ok: true }; } };
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve("./power-quota-mail"), "utf8"), context);
  const result = await context.module.exports.drainPowerQuotaMails({ dryRun: false });
  assert.equal(result.sent, 1);
  assert.equal(messages[0].email, "allowed@product.example.test");
});

test("deleted queued quota recipients are suppressed rather than retried", async () => {
  const month = new Date().toISOString().slice(0, 7);
  const store = { quota_emails: { missing: { key: "missing", uid: "missing", month, email: "recipient@product.example.test", status: "pending" } } };
  const context = { module: { exports: {} }, require(name) {
    if (name === "./store") return { loadStore: async () => store, mutateStore: async mutate => mutate(store) };
    if (name === "./auth") return { initFirebaseAdmin: () => true };
    if (name === "firebase-admin") return { auth: () => ({
      getUser: async () => { throw Object.assign(Error("missing"), { code: "auth/user-not-found" }); },
      listUsers: async () => ({ users: [] }),
    }) };
    if (name === "./mail") return { sendQuotaExhaustedEmail: async () => { throw Error("must not send"); } };
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve("./quota-mail"), "utf8"), context);
  const result = await context.module.exports.drainPendingQuotaMails();
  assert.equal(result.store_error, null);
  assert.equal(result.sent, 0);
  assert.equal(store.quota_emails.missing.status, "suppressed");
});
