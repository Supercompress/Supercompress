/**
 * Password-reset copy unit tests (no Resend / Firebase).
 * Run: node --test api/_lib/password-reset.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { passwordResetCopy } = require("./mail");
const {
  normalizeEmail,
  isValidEmail,
  userHasPasswordProvider,
  CONTINUE_URL,
} = require("./password-reset");

describe("password reset helpers", () => {
  it("normalizes and validates email", () => {
    assert.equal(normalizeEmail("  User@Example.COM "), "user@example.com");
    assert.equal(isValidEmail("user@example.com"), true);
    assert.equal(isValidEmail("nope"), false);
  });

  it("detects password vs Google-only providers", () => {
    assert.equal(
      userHasPasswordProvider({
        providerData: [{ providerId: "google.com" }],
      }),
      false
    );
    assert.equal(
      userHasPasswordProvider({
        providerData: [
          { providerId: "google.com" },
          { providerId: "password" },
        ],
      }),
      true
    );
    assert.equal(userHasPasswordProvider({ providerData: [] }), false);
    assert.equal(userHasPasswordProvider(null), false);
  });

  it("branded copy includes reset url and site branding cues", () => {
    const url = "https://example.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=abc";
    const copy = passwordResetCopy({
      email: "user@example.com",
      resetUrl: url,
      firstName: "Arjun",
    });
    assert.match(copy.subject, /password/i);
    assert.match(copy.text, /Reset your password/i);
    assert.ok(copy.text.includes(url));
    assert.ok(copy.html.includes("Reset password"));
    assert.ok(copy.html.includes("oobCode=abc") || copy.html.includes(url.replace(/&/g, "&amp;")));
    assert.ok(copy.html.includes("SuperCompress") || copy.html.includes("supercompress"));
    assert.ok(CONTINUE_URL.includes("supercompress.dev"));
  });
});
