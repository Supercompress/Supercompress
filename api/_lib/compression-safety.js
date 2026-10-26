const MIN_SAVINGS_RATIO = 0.05;
const MIN_COLLAPSE_INPUT_TOKENS = 1000;
const MIN_RETAINED_RATIO = 0.01;
const MAX_COLLAPSED_OUTPUT_TOKENS = 64;

function countTokens(text) {
  if (!text) return 0;
  return text.split("\n").reduce(
    (total, line) => total + Math.max(1, (line.match(/[A-Za-z_][A-Za-z0-9_]*|[^\s]/g) || []).length),
    0
  );
}

function enforceCompressionSafety(context, candidate) {
  const originalTokens = countTokens(context);
  const result = candidate || {};
  const text = result.compressed_text;
  const candidateTokens = typeof text === "string" ? countTokens(text) : 0;
  let reason = null;
  if (typeof text !== "string" || !text.trim()) {
    reason = "invalid_compression_output";
  } else if (
    originalTokens >= MIN_COLLAPSE_INPUT_TOKENS &&
    candidateTokens <= MAX_COLLAPSED_OUTPUT_TOKENS &&
    candidateTokens / originalTokens < MIN_RETAINED_RATIO
  ) {
    reason = "suspicious_compression_collapse";
  } else if (text.length > context.length || (originalTokens - candidateTokens) / Math.max(1, originalTokens) < MIN_SAVINGS_RATIO) {
    reason = result.compression_safety?.status === "passthrough" && text === context
      ? result.compression_safety.reason
      : "insufficient_compression_savings";
  }

  const keptTokens = reason ? originalTokens : candidateTokens;
  const savedTokens = Math.max(0, originalTokens - keptTokens);
  const savingsPct = originalTokens ? (savedTokens / originalTokens) * 100 : 0;
  const normalized = {
    ...result,
    compressed_text: reason ? context : text,
    original_tokens: originalTokens,
    kept_tokens: keptTokens,
    compressed_tokens: keptTokens,
    tokens_out: keptTokens,
    tokens_saved: savedTokens,
    tokens_removed: savedTokens,
    tokens_saved_pct: savingsPct,
    kv_savings_pct: savingsPct,
    keep_ratio: originalTokens ? keptTokens / originalTokens : 1,
    compression_safety: {
      status: reason ? "passthrough" : "accepted",
      reason,
      token_count_method: "lexical_estimate",
      semantic_verification: "not_performed",
    },
  };
  if (!reason) return normalized;

  const warning = reason === "suspicious_compression_collapse"
    ? "Compression discarded over 99% of a large input into at most 64 estimated tokens; returned the original context. This heuristic does not verify semantic preservation."
    : reason === "invalid_compression_output"
      ? "Compression returned no usable text; returned the original context."
      : "Compression saved less than 5% of estimated tokens (or increased size); returned the original context.";
  return {
    ...normalized,
    mode: "passthrough",
    policy_name: "SuperCompress passthrough",
    fallback_reason: reason,
    warnings: [...new Set([...(Array.isArray(result.warnings) ? result.warnings : []), warning])],
    ccr: null,
    budget_ratio: 1,
    kept_line_ratio: 1,
    answer_quality: null,
    important_kept_pct: null,
    critical_lines_total: null,
    critical_lines_kept: null,
    critical_lines_dropped: null,
    compression_risk: "not_assessed",
    verifier: null,
    kept_blocks: null,
    dropped_blocks: null,
    lines_kept: context.split("\n").length,
  };
}

module.exports = { countTokens, enforceCompressionSafety };
