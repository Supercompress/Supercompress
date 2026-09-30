const assert = require("assert");
const {
  needsCheckoutFallback,
  recoveryEmailCopy,
  recoveryStoreKey,
} = require("./auto-recharge-recovery");

assert.strictEqual(needsCheckoutFallback({ message: "mandate for off-session card payments made with cards issued in India" }), true);
assert.strictEqual(needsCheckoutFallback({ code: "authentication_required" }), true);
assert.strictEqual(needsCheckoutFallback({ status: "requires_action" }), true);
assert.strictEqual(needsCheckoutFallback({ code: "card_declined" }), true);
assert.strictEqual(needsCheckoutFallback({ message: "random network blip" }), false);
assert.strictEqual(needsCheckoutFallback({ status: "processing" }), false);

const copy = recoveryEmailCopy({
  email: "a@b.com",
  firstName: "Jo",
  amount: 10,
  checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test",
  reason: "india_requires_checkout",
});
assert.ok(copy.subject.includes("$10"));
assert.ok(copy.text.includes("https://checkout.stripe.com/c/pay/cs_test"));
assert.ok(/RBI/i.test(copy.text));
// Must use branded chrome, not a bare <div>
assert.ok(copy.html.includes("<!DOCTYPE html>"), "expected branded DOCTYPE");
assert.ok(copy.html.includes("SuperCompress"), "expected brand mark");
assert.ok(copy.html.includes("Confirm $10 recharge"), "expected CTA label");

assert.strictEqual(recoveryStoreKey("uid1", 3), "uid1:c3");

console.log("auto-recharge-recovery.test.js: ok");
