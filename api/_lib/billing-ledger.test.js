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
  emergencyFitCustomClaims,
  claimsByteLength,
  AUTH_CLAIMS_MAX_BYTES,
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

// Auth claims store a 16-char fingerprint prefix — must still replay against full hash
{
  const full = "a".repeat(64);
  assertUsageIdempotencyMatch(
    { fingerprint: full.slice(0, 16), tokens_in: 10, tokens_out: 5, tokens_saved: 5 },
    { fingerprint: full, tokensIn: 10, tokensOut: 5, tokensSaved: 5 }
  );
  assertUsageIdempotencyMatch(
    { fingerprint: full, tokens_in: 10, tokens_out: 5, tokens_saved: 5 },
    { fingerprint: full.slice(0, 16), tokensIn: 10, tokensOut: 5, tokensSaved: 5 }
  );
  mustThrow(
    () =>
      assertUsageIdempotencyMatch(
        { fingerprint: "bbbbbbbbbbbbbbbb", tokens_in: 10, tokens_out: 5, tokens_saved: 5 },
        { fingerprint: full, tokensIn: 10, tokensOut: 5, tokensSaved: 5 }
      ),
    "idempotency_conflict"
  );
}

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

// Claims watermarks truncate request ids to 40 — lookups must still hit
{
  const { claimsRequestId } = require("./billing-ledger");
  const longId = "sc_" + "a".repeat(40);
  assert.strictEqual(claimsRequestId(longId).length, 40);
  assert.strictEqual(claimsRequestId(longId), longId.slice(0, 40));
  // fitCustomClaims only rewrites rows when the payload is over budget; the
  // write path always stores claimsRequestId(rid) so verify can succeed.
  const packed = claimsRequestId(longId);
  assert.ok(packed.length <= 40);
}

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

{
  // Under extreme claim pressure, never drop sc_key_ids (orphan / plan-cap bypass).
  const manyKeys = Array.from({ length: 20 }, (_, i) => `sck_${String(i).padStart(20, "0")}`);
  const fitted = fitCustomClaims({
    sc_write_id: "abc123def456",
    sc_plan: "payg",
    sc_key_ids: manyKeys,
    sc_usage: {
      month: "2026-08",
      tokens_in: 1,
      requests: 1,
      d: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [
          `2026-08-${String(i + 1).padStart(2, "0")}`,
          { tin: 99999, tout: 99999, ts: 1, r: 9 },
        ])
      ),
    },
    sc_recent_billing: Array.from({ length: 12 }, (_, i) => ({
      i: `id${i}${"x".repeat(36)}`,
      f: "f".repeat(64),
      tin: 9999,
      tout: 9999,
      ts: 1,
      b: 0,
      t: 1786630000000,
    })),
    sc_credited_sessions: Array.from({ length: 20 }, (_, i) => `sess_${i}_${"y".repeat(40)}`),
    sc_agent_plugin: { linked: true, linked_at: "2026-01-01", updated_at: "2026-01-01", source: "x" },
    sc_plan_updated: "2026-01-01T00:00:00.000Z",
  });
  assert.ok(Array.isArray(fitted.sc_key_ids), "sc_key_ids must survive fitCustomClaims");
  assert.ok(fitted.sc_key_ids.length >= 1, "sc_key_ids must not be emptied");
  assert.ok(
    claimsByteLength(fitted) <= AUTH_CLAIMS_MAX_BYTES,
    `extreme claims must fit budget, got ${claimsByteLength(fitted)}`
  );
  assert.ok(!("sc_agent_plugin" in fitted) || fitted.sc_agent_plugin == null);
}

{
  const heavy = {
    sc_write_id: "abc123def456",
    sc_plan: "payg",
    sc_billing_rev: 9999,
    sc_key_ids: Array.from({ length: 8 }, (_, i) => `sck_${String(i).padStart(22, "0")}`),
    sc_usage: {
      month: "2026-08",
      tokens_in: 5_000_000,
      requests: 50_000,
      life_in: 999_999_999,
      life_saved: 888_888_888,
      d: Object.fromEntries(
        Array.from({ length: 14 }, (_, i) => [
          `2026-08-${String(i + 1).padStart(2, "0")}`,
          { tin: 99999, tout: 9999, ts: 1, r: 9 },
        ])
      ),
    },
    sc_recent_billing: Array.from({ length: 8 }, (_, i) => ({
      i: `idem_${i}_${"a".repeat(30)}`,
      f: "f".repeat(64),
      tin: 50000,
      tout: 5000,
      ts: 45000,
      b: 1000,
      t: 1786630000000,
    })),
    sc_credited_sessions: Array.from({ length: 6 }, (_, i) => `cs_${i}_${"b".repeat(20)}`),
    sc_heard: "twitter",
    sc_onboard_done: true,
  };
  const fitted = emergencyFitCustomClaims(heavy);
  assert.ok(
    claimsByteLength(fitted) <= AUTH_CLAIMS_MAX_BYTES,
    `heavy user must fit claims budget, got ${claimsByteLength(fitted)}`
  );
  assert.ok(Array.isArray(fitted.sc_key_ids) && fitted.sc_key_ids.length >= 1);
  assert.ok(Array.isArray(fitted.sc_recent_billing) && fitted.sc_recent_billing.length >= 1);
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
