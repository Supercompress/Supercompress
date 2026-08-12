/**
 * Unit tests for Resend/Svix webhook verification.
 * Run: node api/_lib/resend-webhook.test.js
 */
const assert = require("assert");
const crypto = require("crypto");
const {
  verifyResendWebhook,
  shouldNotify,
  MAX_SKEW_SEC,
} = require("./resend-webhook");

function sign(raw, secret, id, timestamp) {
  const secretPart = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const key = Buffer.from(secretPart, "base64");
  const expected = crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestamp}.${raw}`, "utf8")
    .digest("base64");
  return `v1,${expected}`;
}

const secret = `whsec_${Buffer.from("supercompress-test-secret-key!!").toString("base64")}`;
const id = "msg_test_123";
const timestamp = String(Math.floor(Date.now() / 1000));
const payload = JSON.stringify({
  type: "email.received",
  created_at: new Date().toISOString(),
  data: {
    email_id: "em_test",
    from: "user@example.com",
    to: ["hello@supercompress.dev"],
    subject: "Hi",
    attachments: [],
  },
});

const headers = {
  "svix-id": id,
  "svix-timestamp": timestamp,
  "svix-signature": sign(payload, secret, id, timestamp),
};

const event = verifyResendWebhook(payload, headers, secret);
assert.strictEqual(event.type, "email.received");
assert.strictEqual(event.data.email_id, "em_test");

// Tampered body
assert.throws(
  () => verifyResendWebhook(payload + " ", headers, secret),
  /Invalid webhook signature/
);

// Bad secret
assert.throws(
  () => verifyResendWebhook(payload, headers, "whsec_" + Buffer.from("nope").toString("base64")),
  /Invalid webhook signature/
);

// Stale timestamp
const staleTs = String(Math.floor(Date.now() / 1000) - MAX_SKEW_SEC - 60);
assert.throws(
  () =>
    verifyResendWebhook(payload, {
      ...headers,
      "svix-timestamp": staleTs,
      "svix-signature": sign(payload, secret, id, staleTs),
    }, secret),
  /timestamp outside allowed skew/
);

assert.strictEqual(shouldNotify("user@example.com", "Hello"), true);
assert.strictEqual(shouldNotify("arjunkshah21@gmail.com", "Hello"), false);
assert.strictEqual(shouldNotify("user@example.com", "[SC inbound] loop"), false);

console.log("resend-webhook.test.js: ok");
