/**
 * Quota-exhausted email lane unit tests.
 * Run: node --test api/_lib/quota-mail.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  QUOTA_MAIL_CLAIM,
  quotaIdempotencyKey,
  quotaMailAlreadySent,
  isDrainableQuotaMail,
} = require("./quota-mail");
const { quotaExhaustedCopy } = require("./mail");

it("all quota delivery paths honor live opt-outs and historical suppressions", () => {
  const { quotaRecipientSuppressed } = require("./quota-mail");
  const user = { email: "recipient@example.com", customClaims: {} };
  assert.equal(quotaRecipientSuppressed(user, new Set()), false);
  assert.equal(quotaRecipientSuppressed({ ...user, customClaims: { sc_unsub: "1" } }, new Set()), true);
  assert.equal(quotaRecipientSuppressed({ ...user, customClaims: { sc_credit_balance_usd: 10 } }, new Set()), true);
  const hash = require("node:crypto").createHash("sha256").update(user.email).digest("hex");
  assert.equal(quotaRecipientSuppressed(user, new Set([hash])), true);
});

describe("quota mail gating", () => {
  it("claim stamp is per month", () => {
    assert.equal(
      quotaMailAlreadySent({ [QUOTA_MAIL_CLAIM]: "2026-08" }, "2026-08"),
      true,
    );
    assert.equal(
      quotaMailAlreadySent({ [QUOTA_MAIL_CLAIM]: "2026-07" }, "2026-08"),
      false,
    );
    assert.equal(quotaMailAlreadySent({}, "2026-08"), false);
    assert.equal(quotaMailAlreadySent({ sc_power_quota_mail: "2026-08" }, "2026-08"), true);
  });

  it("idempotency key binds uid and month", () => {
    assert.equal(
      quotaIdempotencyKey("u1", "2026-08"),
      "quota-exhausted-u1-2026-08",
    );
    assert.notEqual(
      quotaIdempotencyKey("u1", "2026-08"),
      quotaIdempotencyKey("u1", "2026-09"),
    );
  });

  it("drainable requires current month, retryable status, and an email", () => {
    const base = { uid: "u1", month: "2026-08", email: "a@b.com" };
    assert.equal(
      isDrainableQuotaMail({ ...base, status: "pending" }, "2026-08"),
      true,
    );
    assert.equal(
      isDrainableQuotaMail({ ...base, status: "sending" }, "2026-08"),
      true,
    );
    assert.equal(
      isDrainableQuotaMail({ ...base, status: "failed" }, "2026-08"),
      true,
    );
    assert.equal(
      isDrainableQuotaMail({ ...base, status: "sent" }, "2026-08"),
      false,
    );
    // stale month never drains — no "you're paused" mail after the reset
    assert.equal(
      isDrainableQuotaMail({ ...base, status: "pending" }, "2026-09"),
      false,
    );
    assert.equal(
      isDrainableQuotaMail(
        { ...base, status: "pending", email: "" },
        "2026-08",
      ),
      false,
    );
    assert.equal(isDrainableQuotaMail(null, "2026-08"), false);
  });
});

describe("quota mail copy", () => {
  it("includes usage, billing link, and reset date as a plain note", () => {
    const copy = quotaExhaustedCopy({
      email: "a@b.com",
      firstName: "Sam",
      tokensUsed: 5_234_567,
      freeTokens: 5_000_000,
      month: "2026-08",
    });
    assert.match(copy.subject, /allowance/i);
    assert.match(copy.text, /Hey Sam/);
    assert.match(copy.text, /5\.23M/);
    assert.doesNotMatch(copy.text, /\$\d/);
    assert.match(copy.text, /dashboard\?panel=billing/);
    assert.match(copy.text, /resets on September 1/);
    assert.match(copy.html, /add credits/);
    assert.doesNotMatch(copy.html, /<img|<table/i);
    assert.equal(copy.to, "a@b.com");
  });

  it("reports actual remaining allowance and handles missing month", () => {
    const copy = quotaExhaustedCopy({
      email: "a@b.com",
      tokensUsed: 0,
      freeTokens: 5_000_000,
    });
    assert.match(copy.text, /5,000,000 free monthly tokens remaining/);
    assert.doesNotMatch(copy.text, /You've used your free/);
    assert.match(copy.text, /resets on the 1st of next month/);
  });
});
