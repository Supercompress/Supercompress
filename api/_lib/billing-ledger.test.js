/**
 * Unit tests for billing ledger gate (no Firebase required).
 * Run: node api/_lib/billing-ledger.test.js
 */
const assert = require("assert");
const {
  planUsageBurn,
  FREE_TOKENS_PER_MONTH,
  tokensToMicros,
  computeCompressFingerprint,
  assertUsageIdempotencyMatch,
  fitCustomClaims,
  claimsWriteHeld,
  claimsConflictToken,
} = require("./billing-ledger");

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

// Fingerprint: same payload → same hash; different context → different hash
{
  const a = computeCompressFingerprint({
    context: "hello world catalog noise",
    query: "hello",
    mode: "compiler",
  });
  const b = computeCompressFingerprint({
    context: "hello world catalog noise",
    query: "hello",
    mode: "compiler",
  });
  const c = computeCompressFingerprint({
    context: "completely different dump",
    query: "hello",
    mode: "compiler",
  });
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
  assert.strictEqual(a.length, 64);
}

// Idempotency: same fingerprint replays OK
assertUsageIdempotencyMatch(
  { fingerprint: "abc", tokens_in: 10, tokens_out: 5, tokens_saved: 5 },
  { fingerprint: "abc", tokensIn: 99, tokensOut: 1, tokensSaved: 98 }
);

// Idempotency: different fingerprint → conflict
mustThrow(
  () =>
    assertUsageIdempotencyMatch(
      { fingerprint: "aaa", tokens_in: 10, tokens_out: 5, tokens_saved: 5 },
      { fingerprint: "bbb", tokensIn: 10, tokensOut: 5, tokensSaved: 5 }
    ),
  "idempotency_conflict"
);

// Legacy (no fingerprint): token mismatch → conflict
mustThrow(
  () =>
    assertUsageIdempotencyMatch(
      { tokens_in: 10, tokens_out: 5, tokens_saved: 5 },
      { fingerprint: "newfp", tokensIn: 11, tokensOut: 5, tokensSaved: 6 }
    ),
  "idempotency_conflict"
);

// Legacy (no fingerprint): matching tokens OK
assertUsageIdempotencyMatch(
  { tokens_in: 10, tokens_out: 5, tokens_saved: 5 },
  { fingerprint: "newfp", tokensIn: 10, tokensOut: 5, tokensSaved: 5 }
);

{
  const fitted = fitCustomClaims({
    sc_power_mail: "sent",
    sc_write_id: "abc123def456",
    sc_plan: "free",
    sc_usage: { month: "2026-08", tokens_in: 1, requests: 1 },
    sc_recent_billing: Array.from({ length: 8 }, (_, i) => ({
      i: `id${i}${"x".repeat(36)}`,
      f: "f".repeat(16),
      tin: 9999,
      tout: 9999,
      ts: 1,
      b: 0,
      t: 1786630000000,
    })),
  });
  assert.strictEqual(fitted.sc_power_mail, "sent");
  assert.strictEqual(fitted.sc_write_id, "abc123def456");
}

assert.strictEqual(claimsWriteHeld({ sc_write_id: "aaa" }, "aaa"), true);
assert.strictEqual(claimsWriteHeld({ sc_write_id: "bbb" }, "aaa"), false);
assert.strictEqual(claimsWriteHeld({}, "aaa"), false);
assert.strictEqual(claimsConflictToken({ sc_billing_rev: 10, sc_write_id: "x" }), "10:x");
assert.notStrictEqual(
  claimsConflictToken({ sc_billing_rev: 10, sc_write_id: "x" }),
  claimsConflictToken({ sc_billing_rev: 11, sc_write_id: "x" })
);

console.log("billing-ledger.test.js: ok");
