const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");

test("failed founder alerts log a safe warning without exposing provider details", async () => {
  for (const failure of ["resend_request_failed", "private provider error"]) {
    const store = {};
    const warnings = [];
    let pending;
    const context = {
      module: { exports: {} }, process: { env: {} },
      setImmediate: callback => { pending = callback(); },
      console: { warn: (...args) => warnings.push(args.join(" ")) },
      require(name) {
        if (name === "./store") return { mutateStore: async mutate => mutate(store) };
        if (name === "./mail") return {
          sendAutoRechargeRecoveryEmail: async () => ({ ok: true }),
          sendViaResend: async () => ({ ok: false, error: failure }),
          brandedEmailHtml: () => "fixture",
        };
        return require(name);
      },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve("./auto-recharge-recovery"), "utf8"), context);
    context.module.exports.scheduleAutoRechargeRecoveryNotify({ uid: "fixture", email: "recipient@product.example.test", checkoutUrl: "https://product.example.test/billing", cycle: 1 });
    await pending;
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /founder auto-recharge alert failed: resend_(request|delivery)_failed/);
    assert.ok(!warnings[0].includes("private provider error"));
  }
});
