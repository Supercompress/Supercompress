/**
 * Unit tests for payment thank-you gating (no Resend / Firebase).
 * Run: node api/_lib/payment-thank-you.test.js
 */
const assert = require("assert");
const {
  shouldSendPaymentThankYou,
  paymentThankYouAfterMs,
  DEFAULT_AFTER_ISO,
  thankYouIdempotencyKey,
} = require("./payment-thank-you");
const { paymentThankYouCopy } = require("./mail");

assert.ok(Date.parse(DEFAULT_AFTER_ISO));
assert.strictEqual(paymentThankYouAfterMs(), Date.parse(DEFAULT_AFTER_ISO));

assert.strictEqual(
  shouldSendPaymentThankYou({
    kind: "credit_enable",
    paymentCreatedSec: Math.floor(Date.parse("2026-08-15T00:00:00Z") / 1000),
    alreadyCredited: false,
  }),
  true
);

assert.strictEqual(
  shouldSendPaymentThankYou({
    kind: "credit_topup",
    paymentCreatedSec: Math.floor(Date.parse("2026-08-15T12:00:00Z") / 1000),
    alreadyCredited: false,
  }),
  true
);

// First three sales (before cutoff) must not get a backfilled thank-you
assert.strictEqual(
  shouldSendPaymentThankYou({
    kind: "credit_enable",
    paymentCreatedSec: Math.floor(Date.parse("2026-08-14T03:56:56Z") / 1000),
    alreadyCredited: false,
  }),
  false
);

assert.strictEqual(
  shouldSendPaymentThankYou({
    kind: "credit_auto_recharge",
    paymentCreatedSec: Math.floor(Date.parse("2026-08-20T00:00:00Z") / 1000),
    alreadyCredited: false,
  }),
  false
);

assert.strictEqual(
  shouldSendPaymentThankYou({
    kind: "credit_enable",
    paymentCreatedSec: Math.floor(Date.parse("2026-08-20T00:00:00Z") / 1000),
    alreadyCredited: true,
  }),
  false
);

assert.ok(thankYouIdempotencyKey("cs_test").startsWith("payment-thanks-"));

{
  const copy = paymentThankYouCopy({
    firstName: "Leo",
    email: "leo@example.com",
    creditUsd: 10,
    autoRecharge: true,
  });
  assert.match(copy.subject, /Leo/);
  assert.match(copy.text, /Arjun/);
  assert.match(copy.text, /\$10/);
  assert.match(copy.text, /Auto-recharge/);
  assert.doesNotMatch(copy.html, /<img|<table/i);
  assert.match(copy.html, /hit reply/i);
}

console.log("payment-thank-you.test.js: ok");
