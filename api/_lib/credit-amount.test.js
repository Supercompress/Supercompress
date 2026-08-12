/**
 * Unit tests for paid-credit amount helpers.
 * Run: node api/_lib/credit-amount.test.js
 */
const assert = require("assert");
const {
  paidCreditUsdFromSession,
  isCreditablePaidUsd,
  clampPackUsd,
} = require("./credit-amount");

assert.strictEqual(paidCreditUsdFromSession({ amount_total: 1000 }), 10);
assert.strictEqual(paidCreditUsdFromSession({ amount_total: 0 }), 0);
assert.strictEqual(paidCreditUsdFromSession({ amount: 1500 }), 15);
assert.strictEqual(paidCreditUsdFromSession({}), null);
assert.strictEqual(
  paidCreditUsdFromSession({
    amount_total: 1000,
    metadata: { credit_usd: "1000" },
  }),
  10,
  "must ignore metadata.credit_usd even if inflated"
);

assert.strictEqual(isCreditablePaidUsd(10), true);
assert.strictEqual(isCreditablePaidUsd(0), false, "promo $0 must not credit");
assert.strictEqual(isCreditablePaidUsd(-1), false);
assert.strictEqual(isCreditablePaidUsd(null), false);

assert.strictEqual(clampPackUsd(0), 10, "pack size still min $10");
assert.strictEqual(clampPackUsd(5), 10);
assert.strictEqual(clampPackUsd(25), 25);

console.log("credit-amount.test.js: ok");
