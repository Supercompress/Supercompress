const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");

for (const autoRecharge of [true, false]) {
  test(`Checkout disclosure and card-saving match auto-recharge ${autoRecharge}`, async () => {
    const loaded = { exports: {} };
    const calls = [];
    vm.runInNewContext(fs.readFileSync(require.resolve("./stripe"), "utf8"), {
      module: loaded,
      process: { env: { STRIPE_SECRET_KEY: "sk_test_fake" } },
      require(name) {
        if (name === "stripe") return function Stripe() {
          return { checkout: { sessions: { create: async (options) => {
            calls.push(options);
            return { id: "cs_test", url: "https://checkout.stripe.com/test" };
          } } } };
        };
        throw new Error(`Unexpected dependency ${name}`);
      },
    });
    await loaded.exports.createCreditTopUpCheckout({ customerId: "cus_test", userId: "owner", creditUsd: 25, autoRecharge });
    assert.equal(calls.length, 1);
    const checkout = calls[0];
    assert.equal(checkout.metadata.auto_recharge, String(autoRecharge));
    assert.equal(checkout.payment_intent_data.setup_future_usage, autoRecharge ? "off_session" : undefined);
    assert.match(checkout.custom_text.submit.message, autoRecharge ? /\$25.00.*whenever.*run out/ : /one-time.*OFF/i);
    assert.equal(checkout.line_items[0].price_data.unit_amount, 2500);
  });
}
