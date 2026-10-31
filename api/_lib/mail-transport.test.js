const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");

test("Resend network failures return a safe structured failure", async () => {
  const context = {
    module: { exports: {} }, require, Buffer, URL, AbortSignal, __dirname,
    process: { env: { RESEND_API_KEY: "offline-fixture" }, cwd: () => process.cwd() },
    fetch: async () => { throw Error("private transport details"); },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("./mail"), "utf8"), context);
  const result = await context.module.exports.sendViaResend({ to: "recipient@product.example.test", subject: "Fixture", text: "Fixture" });
  assert.equal(result.ok, false);
  assert.equal(result.provider, "resend");
  assert.equal(result.error, "resend_request_failed");
});
