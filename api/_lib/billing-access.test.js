const assert = require("node:assert/strict");
const test = require("node:test");
const { billingAccess } = require("./billing-access");

test("an empty wallet only exhausts access after free allowance is used", () => {
  assert.equal(billingAccess({ freeRemaining: 100, creditBalance: 0 }).limit_reached, false);
  assert.equal(billingAccess({ freeRemaining: 0, creditBalance: 0 }).limit_reached, true);
  assert.equal(billingAccess({ freeRemaining: 0, creditBalance: 10 }).limit_reached, false);
});

test("a rejected oversized request is visible without pretending all free tokens are used", () => {
  const access = billingAccess({ freeRemaining: 56, creditBalance: 0, blockedThisMonth: true });
  assert.deepEqual(access, { limit_reached: false, request_blocked_this_month: true });
  for (const exemption of [{ creditBalance: 1 }, { comped: true }, { legacyMetered: true }]) {
    assert.deepEqual(billingAccess({ freeRemaining: 0, creditBalance: 0, blockedThisMonth: true, ...exemption }), {
      limit_reached: false, request_blocked_this_month: false,
    });
  }
});
