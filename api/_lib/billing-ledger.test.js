/**
 * Unit tests for billing ledger gate (no Firebase required).
 * Run: node api/_lib/billing-ledger.test.js
 */
const assert = require("assert");
const { planUsageBurn, FREE_TOKENS_PER_MONTH, tokensToMicros } = require("./billing-ledger");

function ledger(partial = {}) {
  return {
    month: "2026-08",
    tokens_in: 0,
    tokens_out: 0,
    tokens_saved: 0,
    requests: 0,
    tokens_reported: 0,
    credit_balance_micros: 0,
    credit_limit_usd: 10,
    auto_recharge: false,
    customer_id: null,
    credited_keys: [],
    updated_at: new Date().toISOString(),
    ...partial,
  };
}

function mustThrow(fn, code) {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    assert.strictEqual(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
  }
  assert.ok(threw, `expected throw ${code}`);
}

// Free user under quota
{
  const r = planUsageBurn(ledger({ tokens_in: 100 }), {
    tokensIn: 50,
    tokensOut: 20,
    tokensSaved: 30,
    claims: { sc_plan: "free" },
  });
  assert.strictEqual(r.ledger.tokens_in, 150);
  assert.strictEqual(r.burned_micros, 0);
}

// Free user cannot cross 1M
mustThrow(
  () =>
    planUsageBurn(ledger({ tokens_in: FREE_TOKENS_PER_MONTH - 10 }), {
      tokensIn: 20,
      tokensOut: 5,
      tokensSaved: 15,
      claims: { sc_plan: "free" },
    }),
  "free_quota_exhausted"
);

// Already at free ceiling
mustThrow(
  () =>
    planUsageBurn(ledger({ tokens_in: FREE_TOKENS_PER_MONTH }), {
      tokensIn: 1,
      tokensOut: 0,
      tokensSaved: 1,
      claims: { sc_plan: "free" },
    }),
  "free_quota_exhausted"
);

// Wallet: reject when burn exceeds balance (no clamp-to-zero)
{
  const balance = tokensToMicros(1000); // enough for 1k billable tokens only
  mustThrow(
    () =>
      planUsageBurn(
        ledger({
          tokens_in: FREE_TOKENS_PER_MONTH,
          credit_balance_micros: balance,
        }),
        {
          tokensIn: 50_000,
          tokensOut: 10_000,
          tokensSaved: 40_000,
          claims: { sc_plan: "payg", sc_metered: false, sc_credit_balance_usd: 0.01 },
        }
      ),
    "credits_exhausted"
  );
}

// Wallet: exact burn succeeds
{
  const billable = 10_000;
  const burn = tokensToMicros(billable);
  const r = planUsageBurn(
    ledger({
      tokens_in: FREE_TOKENS_PER_MONTH,
      credit_balance_micros: burn,
    }),
    {
      tokensIn: billable,
      tokensOut: 1000,
      tokensSaved: 9000,
      claims: { sc_plan: "payg", sc_metered: false, sc_credit_balance_usd: 1 },
    }
  );
  assert.strictEqual(r.burned_micros, burn);
  assert.strictEqual(r.ledger.credit_balance_micros, 0);
  assert.strictEqual(r.ledger.tokens_in, FREE_TOKENS_PER_MONTH + billable);
}

// Cumulative micro-USD: many 1-token burns must not over-charge vs ceil(total)
{
  const claims = { sc_plan: "payg", sc_metered: false, sc_credit_balance_usd: 1 };
  let state = ledger({
    tokens_in: FREE_TOKENS_PER_MONTH,
    credit_balance_micros: 1_000_000, // $1
  });
  let totalBurned = 0;
  for (let i = 0; i < 10; i++) {
    const r = planUsageBurn(state, {
      tokensIn: 1,
      tokensOut: 0,
      tokensSaved: 1,
      claims,
    });
    totalBurned += r.burned_micros;
    state = r.ledger;
  }
  assert.strictEqual(totalBurned, tokensToMicros(10));
  assert.ok(totalBurned < 10, "must be cheaper than 10× ceil(1-token)");
}

// Comped skips gates
{
  const r = planUsageBurn(ledger({ tokens_in: FREE_TOKENS_PER_MONTH * 5 }), {
    tokensIn: 1_000_000,
    tokensOut: 1,
    tokensSaved: 1,
    claims: { sc_comped: true },
  });
  assert.strictEqual(r.burned_micros, 0);
  assert.ok(r.ledger.tokens_in > FREE_TOKENS_PER_MONTH);
}

console.log("billing-ledger.test.js: ok");
