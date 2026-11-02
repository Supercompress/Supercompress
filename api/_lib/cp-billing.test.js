"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createCreditBilling } = require("./cp-billing");

function fakeAccount(claims) {
  const state = { claims: { ...claims } };
  return {
    state,
    deps: {
      env: {},
      claimsLedger: () => true,
      getClaims: async () => ({ ...state.claims }),
      patchClaims: async (_uid, mutator) => {
        state.claims = mutator({ ...state.claims });
        return state.claims;
      },
    },
  };
}

describe("gateway credit billing", () => {
  it("rejects accounts with no prepaid credit (free keys cannot spend on models)", async () => {
    const { deps } = fakeAccount({ sc_plan: "free" });
    const b = createCreditBilling(deps);
    await assert.rejects(b.hold("u1", 0.01), (e) => e.code === "credits_required" && e.status === 402);
  });

  it("holds, settles the actual cost, and tracks today's spend", async () => {
    const acct = fakeAccount({ sc_credit_balance_usd: 10 });
    const b = createCreditBilling(acct.deps);
    const h = await b.hold("u1", 0.5);
    assert.equal(h.amount_usd, 0.5);
    const r = await b.settle(h.id, 0.2);
    assert.equal(r.charged_usd, 0.2);
    assert.equal(acct.state.claims.sc_credit_balance_usd, 9.8);
    assert.equal(acct.state.claims.sc_cp_day.u, 0.2);
    // settling twice never double-charges
    assert.equal((await b.settle(h.id, 0.2)).charged_usd, 0);
  });

  it("concurrent holds cannot spend the same dollars twice", async () => {
    const acct = fakeAccount({ sc_credit_balance_usd: 1 });
    const b = createCreditBilling(acct.deps);
    const a = await b.hold("u1", 0.8);
    const c = await b.hold("u1", 0.8);
    assert.equal(a.amount_usd, 0.8);
    assert.equal(c.amount_usd, 0.2);
    await assert.rejects(b.hold("u1", 0.1), (e) => e.code === "credits_required");
    await b.release(a.id);
    assert.equal((await b.hold("u1", 0.1)).amount_usd, 0.1);
  });

  it("never drives the balance negative", async () => {
    const acct = fakeAccount({ sc_credit_balance_usd: 0.05 });
    const b = createCreditBilling(acct.deps);
    const h = await b.hold("u1", 0.05);
    const r = await b.settle(h.id, 3);
    assert.equal(r.charged_usd, 0.05);
    assert.equal(acct.state.claims.sc_credit_balance_usd, 0);
  });

  it("enforces the daily cap per account", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const acct = fakeAccount({
      sc_credit_balance_usd: 100,
      sc_cp_daily_cap_usd: 5,
      sc_cp_day: { d: today, u: 5 },
    });
    const b = createCreditBilling(acct.deps);
    await assert.rejects(b.hold("u1", 0.1), (e) => e.code === "daily_cap_reached" && e.status === 402);
  });

  it("refuses to run when the Firestore ledger is the source of truth", async () => {
    const acct = fakeAccount({ sc_credit_balance_usd: 10 });
    const b = createCreditBilling({ ...acct.deps, claimsLedger: () => false });
    await assert.rejects(b.hold("u1", 0.1), (e) => e.code === "billing_unavailable" && e.status === 503);
  });
});
