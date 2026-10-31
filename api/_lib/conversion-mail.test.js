const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { CONVERSION_CLAIM, conversionCandidate, createConversionRunner, createConversionStateStore, createSqliteStorage, paidUserIdsFromStripe } = require("./conversion-mail");
const { quotaExhaustedCopy } = require("./mail");

const start = new Date("2026-10-27T05:00:00Z");
const seconds = Math.floor(start.getTime() / 1000);
const daysLater = days => new Date(start.getTime() + days * 86400000);
const account = claims => ({ uid: "human", email: "human@product.example.test", customClaims: { sc_power_mail: "sent", sc_usage: { month: "2026-10", tokens_in: 2000000 }, ...claims } });

function durableHarness(user = account()) {
  const documents = new Map();
  const storage = {
    read: async key => documents.get(key),
    compareAndSet: async (key, expected, state, legacy) => {
      const current = documents.has(key) ? documents.get(key) : legacy;
      if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
      documents.set(key, state);
      return true;
    },
  };
  return { documents, store: createConversionStateStore({ storage, getUser: async () => user }) };
}

describe("durable conversion state", () => {
  it("persists SQLite reservations across independent connections and restarts", () => {
    const fs = require("node:fs");
    const directory = fs.mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "conversion-state-test-"));
    const filename = require("node:path").join(directory, "state.sqlite");
    const first = createSqliteStorage(filename);
    const second = createSqliteStorage(filename);
    const pending = [1, 0, seconds, seconds, "pending"];
    const sent = [...pending.slice(0, 4), "sent"];
    try {
      assert.equal(first.compareAndSet("user", undefined, pending), true);
      assert.equal(second.compareAndSet("user", undefined, pending), false);
      assert.deepEqual(second.read("user"), pending);
      assert.equal(second.compareAndSet("user", pending, sent), true);
      assert.deepEqual(first.read("user"), sent);
    } finally {
      first.close();
      second.close();
    }
    const reopened = createSqliteStorage(filename);
    try {
      assert.deepEqual(reopened.read("user"), sent);
    } finally {
      reopened.close();
      fs.rmSync(directory, { recursive: true });
    }
  });
  it("reserves and completes without modifying full Auth claims", async () => {
    const user = account({ padding: "x".repeat(1000) });
    const before = structuredClone(user.customClaims);
    const { store } = durableHarness(user);
    const candidate = conversionCandidate(user, start);
    assert.equal(await store.write(user, candidate, false), true);
    assert.equal(await store.write(user, candidate, false), false);
    assert.deepEqual(await store.read(user), candidate.state);
    assert.equal(await store.write(user, candidate, true), true);
    assert.equal((await store.read(user))[4], "sent");
    assert.deepEqual(user.customClaims, before);
  });

  it("inherits prior Auth state and suppresses live opt-outs and payments", async () => {
    const user = account({ [CONVERSION_CLAIM]: [1, 0, seconds, seconds, "sent"] });
    const { store } = durableHarness(user);
    assert.deepEqual(await store.read(user), user.customClaims[CONVERSION_CLAIM]);
    const candidate = conversionCandidate(user, daysLater(3));
    user.customClaims.sc_unsub = true;
    assert.equal(await store.write(user, candidate, false), false);
    delete user.customClaims.sc_unsub;
    user.customClaims.sc_subscription_id = "paid";
    assert.equal(await store.write(user, candidate, false), false);
  });

  it("fails closed on malformed persisted state", async () => {
    const user = account();
    const { store, documents } = durableHarness(user);
    documents.set(crypto.createHash("sha256").update(user.uid).digest("hex"), {});
    await assert.rejects(store.read(user), /conversion_state_invalid/);
  });

  it("uses persisted completion instead of absent Auth state", async () => {
    const user = account();
    const state = harness(user, { getState: async () => [1, 2, seconds, seconds, "sent"] });
    assert.equal((await state.runner({ dryRun: false })).sent, 0);
  });
});

function harness(user = account(), overrides = {}) {
  let date = start;
  const messages = [];
  const auth = { listUsers: async () => ({ users: [user] }), getUser: async () => structuredClone(user) };
  const runner = createConversionRunner({
    getAuth: async () => auth, getUnsubscribes: async () => new Set(), getPaidUserIds: async () => new Set(),
    isBlocked: () => false, unsubscribeLinks: () => ({ unsubUrl: "https://www.supercompress.dev/unsubscribe" }),
    reserve: async (live, candidate) => { user.customClaims[CONVERSION_CLAIM] = candidate.state; return true; },
    complete: async (live, candidate) => {
      user.customClaims[CONVERSION_CLAIM] = [...candidate.state.slice(0, 4), "sent"];
      if (candidate.stage === 0) user.customClaims.sc_quota_mail = candidate.month;
      return true;
    },
    send: async message => { messages.push(message); return { ok: true }; }, now: () => date,
    ...overrides,
  });
  return { user, runner, messages, setDay: day => { date = daysLater(day); } };
}

describe("bounded conversion sequence", () => {
  it("defaults to a read-only dry run and requires boolean options", async () => {
    const state = harness();
    assert.equal((await state.runner()).eligible, 1);
    assert.equal(state.messages.length, 0);
    assert.equal(state.user.customClaims[CONVERSION_CLAIM], undefined);
    await assert.rejects(state.runner({ dryRun: 0 }), /invalid_conversion_options/);
  });

  it("sends initial, day-three, day-seven and then stops permanently", async () => {
    const state = harness();
    assert.equal((await state.runner({ dryRun: false })).sent, 1);
    assert.equal(state.user.customClaims.sc_quota_mail, "2026-10");
    assert.equal((await state.runner({ dryRun: false })).sent, 0);
    state.setDay(2);
    assert.equal((await state.runner({ dryRun: false })).sent, 0);
    state.setDay(3);
    assert.equal((await state.runner({ dryRun: false })).sent, 1);
    state.setDay(6);
    assert.equal((await state.runner({ dryRun: false })).sent, 0);
    state.setDay(7);
    assert.equal((await state.runner({ dryRun: false })).sent, 1);
    state.setDay(90);
    assert.equal((await state.runner({ dryRun: false })).sent, 0);
    assert.deepEqual(state.messages.map(message => message.followupStage), [0, 1, 2]);
    assert.equal(new Set(state.messages.map(message => message.idempotencyKey)).size, 3);
    assert.equal(state.messages[2].tokensUsed, 0);
    assert.match(quotaExhaustedCopy(state.messages[2]).text, /last follow-up/);
  });

  it("seeds existing October notices without re-sending them", async () => {
    const state = harness(account({ sc_quota_mail: "2026-10" }));
    const result = await state.runner({ dryRun: false });
    assert.equal(result.sent, 0);
    assert.equal(result.seeded, 1);
    state.setDay(3);
    assert.equal((await state.runner({ dryRun: false })).sent, 1);
    assert.equal(state.messages[0].followupStage, 1);
  });

  it("does not catch up with two follow-ups on the same day", async () => {
    const state = harness(account({ [CONVERSION_CLAIM]: [1, 0, seconds, seconds, "sent"] }));
    state.setDay(10);
    assert.equal((await state.runner({ dryRun: false })).sent, 1);
    assert.equal((await state.runner({ dryRun: false })).sent, 0);
    state.setDay(13);
    assert.equal((await state.runner({ dryRun: false })).sent, 1);
  });

  it("suppresses payments, exhausted paid wallets, and opt-outs", async () => {
    for (const claims of [{ sc_unsub: "1" }, { sc_comped: true }, { sc_plan: "pro" }, { sc_credit_balance_usd: 1 }, { sc_credited_sessions: ["paid"], sc_credit_balance_usd: 0 }, { sc_first_pay_bonus_at: "2026-10-01" }]) {
      assert.equal(conversionCandidate(account(claims), start), null);
    }
    assert.equal(conversionCandidate(account(), start, new Set(["human"])), null);
    const state = harness();
    await state.runner({ dryRun: false });
    state.user.customClaims.sc_credited_sessions = ["paid-now"];
    state.setDay(3);
    assert.equal((await state.runner({ dryRun: false })).sent, 0);
  });

  it("honors durable legacy suppressions and hard blocks", async () => {
    const hash = crypto.createHash("sha256").update("human@product.example.test").digest("hex");
    assert.equal((await harness(account(), { getUnsubscribes: async () => new Set([hash]) }).runner({ dryRun: false })).sent, 0);
    assert.equal((await harness(account(), { isBlocked: () => true }).runner({ dryRun: false })).sent, 0);
  });

  it("fails closed before sends when suppressions or billing cannot be read", async () => {
    for (const override of [ { getUnsubscribes: async () => { throw Error("suppression_unavailable"); } }, { getPaidUserIds: async () => { throw Error("stripe_unavailable"); } } ]) {
      const state = harness(account(), override);
      await assert.rejects(state.runner({ dryRun: false }));
      assert.equal(state.messages.length, 0);
    }
  });

  it("never automatically retries ambiguous delivery or stamp failure", async () => {
    for (const override of [{ send: async () => ({ ok: false }) }, { complete: async () => false }]) {
      const state = harness(account(), override);
      assert.equal((await state.runner({ dryRun: false })).failed, 1);
      assert.equal(state.user.customClaims[CONVERSION_CLAIM][4], "pending");
      state.setDay(4);
      assert.equal((await state.runner({ dryRun: false })).sent, 0);
      assert.equal((await state.runner()).pending_review, 1);
    }
    const failed = harness(account(), { reserve: async () => false });
    assert.equal((await failed.runner({ dryRun: false })).failed, 1);
    assert.equal(failed.messages.length, 0);
  });

  it("rechecks live opt-outs and payment after reserving", async () => {
    for (const change of [{ sc_unsub: "1" }, { sc_credited_sessions: ["just-paid"] }]) {
      const user = account();
      const state = harness(user, { reserve: async (live, candidate) => { Object.assign(user.customClaims, { [CONVERSION_CLAIM]: candidate.state }, change); return true; } });
      assert.equal((await state.runner({ dryRun: false })).sent, 0);
      assert.equal(state.messages.length, 0);
    }
  });

  it("fails closed on corrupt, pending or future sequence state", () => {
    for (const state of [[], {}, [1, 0, seconds, seconds, "pending"], [1, 0, seconds, seconds + 99999, "sent"]]) {
      assert.equal(conversionCandidate(account({ [CONVERSION_CLAIM]: state }), start), null);
    }
  });
});

describe("payment suppression history", () => {
  it("paginates successful charges and ignores failed payments", async () => {
    const originalFetch = global.fetch;
    const originalSecret = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = "offline";
    let calls = 0;
    try {
      global.fetch = async url => {
        calls += 1;
        if (calls === 2) assert.equal(url.searchParams.get("starting_after"), "charge1");
        return { ok: true, json: async () => calls === 1 ? { has_more: true, data: [{ id: "charge1", paid: false, status: "failed", billing_details: { email: "human@product.example.test" } }] } : { has_more: false, data: [{ id: "charge2", paid: true, status: "succeeded", billing_details: { email: "human@product.example.test" } }] } };
      };
      const paid = await paidUserIdsFromStripe({ listUsers: async () => ({ users: [account()] }) });
      assert.equal(paid.has("human"), true);
      assert.equal(calls, 2);
    } finally {
      global.fetch = originalFetch;
      if (originalSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = originalSecret;
    }
  });
});
