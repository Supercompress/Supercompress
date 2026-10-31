const test = require("node:test");
const assert = require("node:assert/strict");
const { FREE_TOKENS_PER_MONTH, freeAllowance, freeTokensRemaining, billableTokens, USD_PER_MILLION } = require("./stripe");
const { planUsageBurn, usdToMicros } = require("./billing-ledger");
const { FIRST_PAY_BONUS_TOKENS, FIRST_PAY_BONUS_USD } = require("./credit-topup");
const { quotaExhaustedCopy } = require("./mail");

test("free allowance is exactly 1M even with historical promotion claims", () => {
  assert.equal(FREE_TOKENS_PER_MONTH, 1_000_000);
  assert.equal(USD_PER_MILLION, 0.1);
  for (const bonus of [0, 30_000, 40_000, 5_000_000]) {
    const claims = { sc_onboard_bonus: bonus };
    assert.equal(freeAllowance(claims), 1_000_000);
    assert.equal(freeTokensRemaining(999_999, claims), 1);
    assert.equal(freeTokensRemaining(1_000_000, claims), 0);
    assert.equal(billableTokens(1_000_001, claims), 1);
  }
});

test("1M boundary accepts the last free token and rejects further or oversized requests", () => {
  const claims = { sc_plan: "free", sc_onboard_bonus: 40_000 };
  const ledger = { tokens_in: 999_999, credit_balance_micros: 0 };
  const request = { tokensIn: 1, tokensOut: 1, tokensSaved: 0, claims };
  const accepted = planUsageBurn(ledger, request);
  assert.equal(accepted.ledger.tokens_in, 1_000_000);
  assert.equal(accepted.burned_micros, 0);
  assert.throws(() => planUsageBurn(accepted.ledger, request), { code: "free_quota_exhausted" });
  assert.throws(() => planUsageBurn(ledger, { ...request, tokensIn: 2 }), { code: "free_quota_exhausted" });
  assert.equal(ledger.tokens_in, 999_999);
});

test("existing paid balances are preserved and only post-free tokens burn credit", () => {
  const claims = { sc_plan: "payg", sc_credit_balance_usd: 10 };
  const ledger = { tokens_in: 500_000, credit_balance_micros: usdToMicros(10) };
  const result = planUsageBurn(ledger, { tokensIn: 1_000_000, tokensOut: 0, tokensSaved: 0, claims });
  assert.equal(result.burned_micros, usdToMicros(0.05));
  assert.equal(result.ledger.credit_balance_micros, usdToMicros(9.95));
  assert.equal(ledger.credit_balance_micros, usdToMicros(10));
  assert.equal(claims.sc_credit_balance_usd, 10);
});

test("new top-ups no longer mint first-payment promotional credit", () => {
  assert.equal(FIRST_PAY_BONUS_TOKENS, 0);
  assert.equal(FIRST_PAY_BONUS_USD, 0);
});

test("quota email defaults to current 1M allowance rather than retired launch offer", () => {
  const copy = quotaExhaustedCopy({ email: "human@product.example.test", tokensUsed: 1_000_000 });
  assert.match(copy.text, /free 1M tokens/);
  assert.doesNotMatch(copy.text, /5M|Launch promo/);
});
