"use strict";

const STRATEGIES = new Set(["neural_keep", "compiler", "skip", "unknown"]);
const UNITS = new Set(["tokens", "bytes", "chars"]);

/**
 * Build a CompressionTrace from compress stats.
 * Never includes query/ask text — sizes and strategy only.
 */
function buildCompressionTrace(input = {}) {
  const unit = UNITS.has(input.unit) ? input.unit : "tokens";
  const original = Math.max(0, Number(input.original_tokens ?? input.original ?? 0) || 0);
  const retained = Math.max(0, Number(input.retained_tokens ?? input.kept_tokens ?? input.retained ?? 0) || 0);
  let strategy = String(input.strategy || "unknown");
  if (!STRATEGIES.has(strategy)) strategy = "unknown";

  const ratio =
    original > 0 ? Math.round((retained / original) * 1e6) / 1e6 : strategy === "skip" ? 1 : 0;

  const trace = {
    original_tokens: original,
    retained_tokens: retained,
    unit,
    ratio,
    strategy,
  };

  if (input.confidence != null && Number.isFinite(Number(input.confidence))) {
    trace.confidence = Math.min(1, Math.max(0, Number(input.confidence)));
  }
  if (strategy === "skip") {
    trace.skip_reason = String(input.skip_reason || "unspecified");
  } else if (input.skip_reason) {
    trace.skip_reason = String(input.skip_reason);
  }
  if (Array.isArray(input.model_eligibility)) {
    trace.model_eligibility = input.model_eligibility.map(String);
  } else {
    trace.model_eligibility = [];
  }
  if (input.dollars_avoided_est != null && Number.isFinite(Number(input.dollars_avoided_est))) {
    trace.dollars_avoided_est = Number(input.dollars_avoided_est);
  }
  if (input.meta && typeof input.meta === "object") {
    trace.meta = { ...input.meta };
  }
  return trace;
}

/**
 * Rough $ avoided vs sending original tokens at usdPerMTok (default $0.10 / 1M = SC meter).
 */
function estimateDollarsAvoided(originalTokens, retainedTokens, usdPerMTok = 0.1) {
  const saved = Math.max(0, Number(originalTokens || 0) - Number(retainedTokens || 0));
  return Math.round((saved / 1e6) * Number(usdPerMTok) * 1e6) / 1e6;
}

function inferStrategyFromResult(result = {}) {
  if (result.skipped || result.strategy === "skip") return "skip";
  if (result.engine === "compiler" || result.strategy === "compiler") return "compiler";
  if (result.engine === "neural_keep" || result.neural_keep || result.strategy === "neural_keep") {
    return "neural_keep";
  }
  if (result.kv_savings_pct != null || result.tokens_saved_pct != null) return "neural_keep";
  return "unknown";
}

/**
 * From a typical compress API result object.
 */
function traceFromCompressResult(result = {}, opts = {}) {
  const original = result.original_tokens ?? 0;
  const retained = result.kept_tokens ?? result.compressed_tokens ?? result.tokens_out ?? 0;
  const strategy = opts.strategy || inferStrategyFromResult(result);
  const dollars =
    opts.dollars_avoided_est != null
      ? opts.dollars_avoided_est
      : estimateDollarsAvoided(original, retained, opts.usdPerMTok);
  return buildCompressionTrace({
    original_tokens: original,
    retained_tokens: retained,
    unit: "tokens",
    strategy,
    confidence: opts.confidence ?? result.confidence ?? result.retention_score,
    skip_reason: opts.skip_reason ?? result.skip_reason,
    model_eligibility: opts.model_eligibility ?? result.model_eligibility,
    dollars_avoided_est: dollars,
    meta: opts.meta,
  });
}

module.exports = {
  buildCompressionTrace,
  estimateDollarsAvoided,
  inferStrategyFromResult,
  traceFromCompressResult,
  STRATEGIES,
  UNITS,
};
