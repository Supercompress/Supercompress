const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { POWER_QUOTA_MAIL_CLAIM, powerQuotaCandidate, createPowerQuotaRunner } = require("./power-quota-mail");
const { quotaExhaustedCopy } = require("./mail");
const { QUOTA_MAIL_CLAIM, quotaMailAlreadySent, quotaIdempotencyKey } = require("./quota-mail");

const month = "2026-10";
function user(uid = "power", claims = {}) {
  return { uid, email: `${uid}@product.example.test`, customClaims: { sc_power_mail: "sent", ...claims } };
}

function harness(users, overrides = {}) {
  const messages = [];
  const stamps = [];
  const accounts = new Map(users.map(account => [account.uid, account]));
  const runner = createPowerQuotaRunner({
    getAuth: async () => ({ listUsers: async () => ({ users }), getUser: async uid => accounts.get(uid) }),
    send: async message => { messages.push(message); return { ok: true }; },
    stamp: async (uid, field, value) => {
      stamps.push({ uid, field, value });
      accounts.get(uid).customClaims[field] = value;
      return true;
    },
    getUnsubscribes: async () => ({}),
    isBlocked: () => false,
    unsubscribeLinks: () => ({ unsubUrl: "https://www.supercompress.dev/unsubscribe" }),
    now: () => new Date("2026-10-26T12:00:00Z"),
    ...overrides,
  });
  return { runner, messages, stamps };
}

describe("power quota eligibility", () => {
  it("includes historical and current power users, not only exhausted accounts", () => {
    assert.equal(powerQuotaCandidate(user(), month).tokensUsed, 0);
    const current = user("active", { sc_power_mail: null, sc_usage: { month, tokens_in: 1_000_000 }, sc_onboard_bonus: 20_000 });
    assert.equal(powerQuotaCandidate(current, month).tokensUsed, 1_000_000);
    assert.equal(powerQuotaCandidate(current, month).freeTokens, 1_000_000);
    assert.equal(powerQuotaCandidate(user("old", { sc_usage: { month: "2026-09", tokens_in: 4_999_999 } }), month).tokensUsed, 0);
  });

  it("skips paid access, opt-outs, duplicates, and non-power users", () => {
    for (const claims of [
      { sc_comped: true }, { sc_metered: true }, { sc_plan: "pro" },
      { sc_credit_balance_usd: 10 }, { sc_unsub: "1" },
      { sc_quota_mail: month }, { [POWER_QUOTA_MAIL_CLAIM]: month },
      { sc_power_mail: null, sc_usage: { month, tokens_in: 999_999 } },
    ]) assert.equal(powerQuotaCandidate(user("excluded", claims), month), null);
    assert.equal(powerQuotaCandidate({ ...user(), disabled: true }, month), null);
    assert.equal(powerQuotaCandidate({ ...user(), uid: "sck_stub" }, month), null);
    assert.equal(powerQuotaCandidate({ ...user(), email: "test@example.com" }, month), null);
  });

  it("includes empty-credit PAYG accounts and binds idempotency to month", () => {
    const account = user("empty", { sc_plan: "payg", sc_metered: false, sc_credit_balance_usd: 0 });
    assert.ok(powerQuotaCandidate(account, month));
    assert.equal(powerQuotaCandidate(account, month).idempotencyKey, quotaIdempotencyKey(account.uid, month));
    assert.notEqual(powerQuotaCandidate(account, month).idempotencyKey, powerQuotaCandidate(account, "2026-11").idempotencyKey);
  });
});

describe("power quota delivery", () => {
  it("dry runs never send or stamp", async () => {
    const state = harness([user()]);
    const result = await state.runner();
    assert.equal(result.eligible, 1);
    assert.equal(result.sent, 0);
    assert.equal(state.messages.length + state.stamps.length, 0);
    await assert.rejects(state.runner({ dryRun: 0 }), /invalid_dry_run/);
  });

  it("sends once per month with truthful current usage and unsubscribe", async () => {
    const state = harness([user("previous", { sc_usage: { month: "2026-09", tokens_in: 3_000_000 } })]);
    assert.equal((await state.runner({ dryRun: false })).sent, 1);
    assert.equal((await state.runner({ dryRun: false })).sent, 0);
    assert.equal(state.messages[0].tokensUsed, 0);
    assert.ok(state.messages[0].unsubUrl);
    assert.equal(state.stamps[0].field, QUOTA_MAIL_CLAIM);
    assert.equal(quotaMailAlreadySent({ [state.stamps[0].field]: state.stamps[0].value }, month), true);
    assert.equal(quotaMailAlreadySent({ [POWER_QUOTA_MAIL_CLAIM]: month }, month), true);
    assert.equal(quotaMailAlreadySent({ [POWER_QUOTA_MAIL_CLAIM]: month }, "2026-11"), false);
    const copy = quotaExhaustedCopy(state.messages[0]);
    assert.match(copy.text, /compressed 0 tokens/);
    assert.doesNotMatch(copy.text + copy.html, /compression is paused/);
  });

  it("honors store suppressions and hard blocks", async () => {
    const state = harness([user("optout"), user("blocked")], {
      getUnsubscribes: async () => ({ "optout@product.example.test": true }),
      isBlocked: recipient => recipient.email === "blocked@product.example.test",
    });
    assert.equal((await state.runner({ dryRun: false })).sent, 0);
  });

  it("rechecks live claims before sending", async () => {
    const state = harness([user()], {
      getAuth: async () => ({ listUsers: async () => ({ users: [user()] }), getUser: async () => user("power", { sc_unsub: "1" }) }),
    });
    assert.equal((await state.runner({ dryRun: false })).sent, 0);
  });

  it("stops on provider or persistence failure instead of blasting retries", async () => {
    const failed = harness([user("first"), user("second")], { send: async () => ({ ok: false }) });
    assert.equal((await failed.runner({ dryRun: false })).error, "mail_delivery_failed");
    assert.equal(failed.stamps.length, 0);
    const unstamped = harness([user("first"), user("second")], { stamp: async () => false });
    const result = await unstamped.runner({ dryRun: false });
    assert.equal(result.sent, 1);
    assert.equal(result.error, "mail_sent_but_stamp_failed");
    assert.equal(unstamped.messages.length, 1);
  });

  it("fails closed when suppression data cannot be read", async () => {
    const state = harness([user()], { getUnsubscribes: async () => { throw Error("store_unavailable"); } });
    await assert.rejects(state.runner({ dryRun: false }), /store_unavailable/);
    assert.equal(state.messages.length, 0);
  });

  it("enforces a bounded send cap", async () => {
    const state = harness([user("first"), user("second")]);
    assert.equal((await state.runner({ cap: 1, dryRun: false })).sent, 1);
    await assert.rejects(state.runner({ cap: 0 }), /invalid_mail_cap/);
  });
});
