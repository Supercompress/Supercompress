/**
 * Response safety for /api/v1/compress (and the MCP servers that wrap it).
 *
 * 1. Queryless / generic asks ("Summarize this context.") must not run query-anchored
 *    extraction: with nothing specific to anchor on it kept ~20 tokens of an 11k page.
 *    Those requests use the budgeted digest instead (dump mode).
 * 2. A result that cannot beat its input by MIN_SAVINGS_PCT is a passthrough: return the
 *    original text unchanged and do not bill it.
 * 3. Very deep cuts on large inputs carry an explicit warning with the numbers, so a
 *    near-empty digest is never silent.
 * 4. Free-quota state rides along on every billed response, with a warning near and at zero.
 */

const DUMP_KEEP_RATIO = 0.5;
const MIN_SAVINGS_PCT = 5;
const DEEP_CUT_MIN_INPUT_TOKENS = 1500;
const DEEP_CUT_MAX_KEPT_RATIO = 0.03;
const QUOTA_LOW_RATIO = 0.1;

// Asks that name no target: summarize/compress/shrink this, or the npm client's defaults.
const GENERIC_QUERY = new RegExp(
  "^(?:please\\s+)?(?:summari[sz]e|compress|shrink|condense|reduce|digest|compact|tl;?dr)" +
    "(?:\\s+(?:this|the|that|it|above|following|all|everything))?" +
    "(?:\\s+(?:context|text|document|doc|page|content|output|tool output|dump|logs?|file|data|input|session memory|memory))?" +
    "(?:\\s+for\\s+(?:the|this)\\s+(?:coding\\s+)?task)?\\s*[.!]?$" +
    "|^coding-agent context dump\\b",
  "i"
);

function isGenericQuery(query) {
  const q = String(query || "").trim();
  if (!q) return true;
  // "(part 2/3)" suffixes come from chunked clients.
  return GENERIC_QUERY.test(q.replace(/\s*\(part \d+\/\d+\)\s*$/i, ""));
}

function pct(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

/** Decide whether a compression result is safe and worth returning. */
function assessResult({ originalTokens, keptTokens, dumpMode = false }) {
  const original = Number(originalTokens) || 0;
  const kept = Number(keptTokens) || 0;
  const savedPct = original > 0 ? 100 - pct(kept, original) : 0;
  if (original <= 0 || kept >= original || savedPct < MIN_SAVINGS_PCT) {
    return {
      passthrough: true,
      reason: kept > original ? "output_larger_than_input" : "no_meaningful_savings",
      saved_pct: Math.max(0, Math.round(savedPct * 10) / 10),
    };
  }
  if (!dumpMode && original >= DEEP_CUT_MIN_INPUT_TOKENS && kept / original < DEEP_CUT_MAX_KEPT_RATIO) {
    return {
      passthrough: false,
      warning:
        `Deep cut: kept ${kept.toLocaleString("en-US")} of ${original.toLocaleString("en-US")} tokens ` +
        `(${pct(kept, original)}%). Only lines matching the query survived; everything else was dropped. ` +
        "If you need more than that specific answer, retry with a more specific query, or omit the query " +
        "to get a dump-mode digest that keeps about half of the input.",
    };
  }
  return { passthrough: false };
}

/**
 * Free-quota status after a billed request. `tokensUsed` is this month's tokens_in
 * including the request; `allowance` is the account's free allowance.
 */
function quotaStatus({ tokensUsed, allowance, comped = false, creditBalanceUsd = null }) {
  const used = Math.max(0, Number(tokensUsed) || 0);
  const free = Math.max(0, Number(allowance) || 0);
  const remaining = Math.max(0, free - used);
  const status = {
    tokens_used_this_period: used,
    free_allowance: free,
    free_tokens_remaining: remaining,
    billing: comped ? "comped" : remaining > 0 ? "free" : "paid",
  };
  if (creditBalanceUsd != null && Number.isFinite(Number(creditBalanceUsd))) {
    status.credit_balance_usd = Number(creditBalanceUsd);
  }
  if (comped || free <= 0) return status;
  if (remaining === 0) {
    status.warning =
      `Free monthly quota used: ${used.toLocaleString("en-US")} of ${free.toLocaleString("en-US")} tokens. ` +
      "Further requests bill credits or pay-as-you-go ($0.10 per 1M input tokens), or stop with a paywall " +
      "if neither is set up: https://www.supercompress.dev/dashboard#billing";
  } else if (remaining <= free * QUOTA_LOW_RATIO) {
    status.warning =
      `Free quota nearly used: ${remaining.toLocaleString("en-US")} of ${free.toLocaleString("en-US")} ` +
      "tokens left this month. https://www.supercompress.dev/dashboard#billing";
  }
  return status;
}

module.exports = {
  DUMP_KEEP_RATIO,
  MIN_SAVINGS_PCT,
  DEEP_CUT_MIN_INPUT_TOKENS,
  DEEP_CUT_MAX_KEPT_RATIO,
  isGenericQuery,
  assessResult,
  quotaStatus,
};
