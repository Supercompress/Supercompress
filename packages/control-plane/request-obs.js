"use strict";

/**
 * Per-request observability record ("obs"): one per gateway request, keyed by request id,
 * stored on the ledger row at meta.obs and exported to OTel.
 *
 * Metadata only. Never put prompt, completion, tool-call or key material in here: every
 * field is a number, a boolean, a model/provider id, or a code from a fixed vocabulary.
 */

const { priceUsd } = require("./catalog");

const OBS_VERSION = 1;

/** Error codes operators and customers can rely on. */
const ERROR_CODES = new Set([
  "auth_required",
  "credits_required",
  "daily_cap_reached",
  "billing_unavailable",
  "money_store_unavailable",
  "insufficient_balance",
  "rate_limited",
  "model_not_found",
  "model_not_allowed",
  "model_denied",
  "max_usd_per_request",
  "max_usd_per_day",
  "no_viable_model",
  "over_budget_after_compress",
  "idempotency_key_in_progress",
  "enterprise_denied",
  "client_closed_request",
  "upstream_timeout",
  "upstream_unavailable",
  "upstream_provider_unavailable",
  "upstream_stream_error",
  "provider_unknown",
  "provider_error",
  "provider_bad_request",
  "gateway_error",
]);

function round6(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}

function num(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

/** Strip anything that is not a short snake_case token (codes must never carry free text). */
function safeToken(s) {
  const m = String(s || "").toLowerCase().match(/^[a-z][a-z0-9_]{0,63}/);
  return m ? m[0] : null;
}

/**
 * Gateway error → stable code. Prefers an explicit known code, then maps known messages.
 * Unknown upstream failures become provider_error / provider_bad_request by status.
 */
function errorCode(error) {
  if (!error) return null;
  const code = safeToken(error.code);
  if (code && ERROR_CODES.has(code)) return code;
  const msg = String(error.message || "");
  if (/^auth_required/.test(msg)) return "auth_required";
  if (/rpm_exceeded|tpm_exceeded|rate_limited/.test(msg) || error.status === 429) return "rate_limited";
  if (/^model_not_found/.test(msg)) return "model_not_found";
  if (/^post_compress_usd/.test(msg)) return "over_budget_after_compress";
  const first = safeToken(msg.split(/[,:\s]/)[0]);
  if (first && ERROR_CODES.has(first)) return first;
  if (error.class === "error" || Number(error.status) >= 500) {
    const s = Number(error.status);
    if (s >= 400 && s < 500 && s !== 499) return "provider_bad_request";
    return "provider_error";
  }
  if (error.class === "rejected") return "rejected";
  return "gateway_error";
}

/**
 * Gateway outcome → HTTP status (shared by the HTTP edge and the obs record).
 * Rate limits are 429, an unavailable money/billing store 503, idempotency conflicts 409.
 */
function httpStatusFor(error = {}) {
  const msg = String(error.message || "");
  const code = String(error.code || "");
  if (msg === "auth_required" || code === "auth_required") return 401;
  if (error.status && error.status >= 400 && error.status < 600 && error.status !== 499) return error.status;
  if (/rpm_exceeded|tpm_exceeded|rate_limited/.test(msg)) return 429;
  if (/unavailable/.test(msg) || /unavailable/.test(code)) return 503;
  if (/model_not_allowed|model_denied|model_not_found/.test(msg)) return 400;
  if (/no_viable_model|post_compress_usd/.test(msg)) return 422;
  if (error.class === "rejected") return 402;
  return 502;
}

function catalogGet(catalog, id) {
  if (!id || !catalog) return null;
  if (typeof catalog.get === "function") return catalog.get(id) || null;
  const list = Array.isArray(catalog) ? catalog : catalog.models || [];
  return list.find((m) => m.id === id) || null;
}

function catalogModels(catalog) {
  if (!catalog) return [];
  return Array.isArray(catalog) ? catalog : catalog.models || [];
}

/**
 * The model the request would have used without SuperCompress routing:
 * the named model, or for "auto" the most expensive model of the highest tier (the "top model").
 */
function baselineModel(requested, catalog, inTok, outTok, autoName = "auto") {
  if (requested && requested !== autoName) {
    const entry = catalogGet(catalog, requested);
    return entry ? { entry, basis: "requested" } : null;
  }
  const models = catalogModels(catalog).filter((m) => m && m.health !== "down");
  if (!models.length) return null;
  const topTier = Math.max(...models.map((m) => Number(m.tier) || 0));
  const top = models
    .filter((m) => (Number(m.tier) || 0) === topTier)
    .sort((a, b) => priceUsd(b, inTok, outTok) - priceUsd(a, inTok, outTok))[0];
  return top ? { entry: top, basis: "top_model" } : null;
}

/**
 * List price, counterfactual price and savings split.
 *   baseline_usd  = price(baseline model, input before compression, output)
 *   list_usd      = price(routed model, input sent, output)
 *   saved_compression_usd = price(routed, input before compression) - list_usd
 *   saved_routing_usd     = baseline_usd - price(routed, input before compression)
 * Routing savings can be negative (a fallback or "auto" picked a pricier model): kept signed.
 */
function computeCost({ catalog, requested, routed, inputTokens, outputTokens, tokensSaved, chargedUsd, autoName }) {
  const inTok = Math.max(0, Number(inputTokens) || 0);
  const outTok = Math.max(0, Number(outputTokens) || 0);
  const saved = Math.max(0, Number(tokensSaved) || 0);
  const routedEntry = catalogGet(catalog, routed);
  const base = baselineModel(requested, catalog, inTok + saved, outTok, autoName);
  const list = routedEntry ? priceUsd(routedEntry, inTok, outTok) : null;
  const routedUncompressed = routedEntry ? priceUsd(routedEntry, inTok + saved, outTok) : null;
  const baselineUsd = base ? priceUsd(base.entry, inTok + saved, outTok) : null;
  const savedCompression = list != null ? round6(routedUncompressed - list) : null;
  const savedRouting = baselineUsd != null && routedUncompressed != null ? round6(baselineUsd - routedUncompressed) : null;
  return {
    list_usd: list,
    charged_usd: num(chargedUsd),
    baseline_model: base?.entry?.id || null,
    baseline_basis: base?.basis || null,
    baseline_usd: baselineUsd,
    saved_routing_usd: savedRouting,
    saved_compression_usd: savedCompression,
    saved_total_usd:
      savedRouting != null || savedCompression != null ? round6((savedRouting || 0) + (savedCompression || 0)) : null,
  };
}

/** Prompt-free size estimate used when a stream ends before the provider reports usage. */
function estimateTokensFromChars(chars) {
  return Math.ceil((Number(chars) || 0) / 4);
}

/**
 * Build the obs record from the pipeline context. Safe to call at any stage: missing pieces
 * are null. `opts.catalog` is the normalized catalog.
 */
function buildRequestObs(ctx = {}, opts = {}) {
  const autoName = opts.autoName || "auto";
  const now = opts.now != null ? opts.now : Date.now();
  const started = Number(ctx.started_at_ms) || now;
  const requested = ctx.model_requested_original || ctx.normalized?.model || null;
  const isAuto = requested === autoName;
  const decision = ctx.route_decision || null;
  const rc = ctx.request_class || null;

  const routing = {
    requested_model: requested,
    model: ctx.model_routed || null,
    provider: ctx.provider_name || decision?.provider || catalogGet(opts.catalog, ctx.model_routed)?.provider || null,
    mode: isAuto ? "auto" : "passthrough",
    strategy: decision?.strategy || null,
    reason: decision?.reason || null,
    classifier: rc
      ? {
          tier: num(rc.tier),
          category: safeToken(rc.category),
          difficulty: safeToken(rc.difficulty),
          reasons: Array.isArray(rc.reasons) ? rc.reasons.map(safeToken).filter(Boolean).slice(0, 12) : [],
          // Learned difficulty probability (null when the task rules decided the tier).
          difficulty_score: num(rc.difficulty_score),
        }
      : null,
  };

  const c = ctx.compression || null;
  const cr = ctx.compress_result || {};
  const compression = c
    ? {
        engine: safeToken(cr.engine) || (c.strategy === "skip" ? null : safeToken(c.strategy)),
        mode: safeToken(c.strategy),
        original_tokens: num(c.original_tokens),
        retained_tokens: num(c.retained_tokens),
        tokens_saved: Math.max(0, (Number(c.original_tokens) || 0) - (Number(c.retained_tokens) || 0)),
        ratio: num(c.ratio),
        passthrough_reason: c.skip_reason ? safeToken(c.skip_reason) : null,
        latency_ms: num(ctx.timings?.compress_ms),
      }
    : null;

  const pr = ctx.provider_result || {};
  let usage = pr.usage ? { ...pr.usage } : null;
  let usageEstimated = false;
  const streamedEarlyEnd = ctx.stream_cancelled || ctx.stream_error;
  if (ctx.stream_chars > 0 || streamedEarlyEnd) {
    // The stream ended (client disconnect / upstream error) before the provider reported
    // full usage: fill the missing side from sizes we know, and say so.
    usage = usage || {};
    if (!(Number(usage.output_tokens) > 0) && ctx.stream_chars > 0) {
      usage.output_tokens = estimateTokensFromChars(ctx.stream_chars);
      usageEstimated = true;
    }
    if (!(Number(usage.input_tokens) > 0) && ctx.input_tokens_sent_est > 0) {
      usage.input_tokens = ctx.input_tokens_sent_est;
      usageEstimated = true;
    }
  }
  const attempts = Array.isArray(ctx.attempts) ? ctx.attempts : [];
  const failed = attempts.filter((a) => a.status !== "ok");
  const lastAttempt = attempts[attempts.length - 1] || null;
  const providerCalled = attempts.length > 0;
  const err = ctx.aborted ? ctx.error || { class: "error" } : null;
  const code = err ? errorCode(err) : null;
  const cancelled = code === "client_closed_request";

  const provider = providerCalled
    ? {
        name: lastAttempt?.provider || null,
        model: lastAttempt?.model || null,
        status: !err ? "ok" : cancelled ? "cancelled" : "error",
        ttft_ms: num(ctx.timings?.ttft_ms),
        latency_ms: num(ctx.timings?.provider_ms),
        input_tokens: usage ? num(usage.input_tokens) : null,
        output_tokens: usage ? num(usage.output_tokens) : null,
        cached_input_tokens: usage ? num(usage.cached_input_tokens) || 0 : null,
        usage_estimated: usageEstimated,
        finish_reason: safeToken(pr.finish_reason),
        attempts: attempts.length,
        retries: Math.max(0, attempts.length - 1),
        fallbacks: failed.map((a) => ({
          provider: a.provider,
          model: a.model,
          http_status: num(a.http_status),
          code: a.code,
          ms: num(a.ms),
        })),
      }
    : null;

  let cost = null;
  if (providerCalled && usage) {
    cost = computeCost({
      catalog: opts.catalog,
      requested,
      routed: ctx.model_routed,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      tokensSaved: compression?.tokens_saved,
      chargedUsd: err ? 0 : ctx.actual_usd,
      autoName,
    });
  } else {
    // No provider call (rejected before it) costs nothing; a failed call with no usage
    // reported has an unknown list price.
    cost = { list_usd: providerCalled ? null : 0, charged_usd: err ? 0 : num(ctx.actual_usd) ?? 0 };
  }

  return {
    v: OBS_VERSION,
    request_id: ctx.request_id || null,
    stream: ctx.normalized?.stream === true,
    latency_ms: Math.max(0, now - started),
    routing,
    compression,
    provider,
    cost,
    error: err
      ? {
          code,
          http_status: cancelled ? 499 : httpStatusFor(err),
          class: cancelled ? "cancelled" : safeToken(err.class) || "error",
        }
      : null,
  };
}

/** Compact row for the ops UI table (no content, no key ids). */
function obsRow(rec = {}) {
  const o = rec.meta?.obs || {};
  return {
    id: rec.id,
    created_at: rec.created_at,
    agent_id: rec.agent_id || null,
    status: o.error ? o.error.class : rec.error_class ? "error" : "ok",
    error_code: o.error?.code || null,
    http_status: o.error?.http_status ?? (rec.error_class ? null : 200),
    stream: Boolean(o.stream),
    requested_model: o.routing?.requested_model || rec.model_requested || null,
    model: o.routing?.model || rec.model_routed || null,
    provider: o.routing?.provider || rec.provider || null,
    mode: o.routing?.mode || null,
    tier: o.routing?.classifier?.tier ?? null,
    route_reason: o.routing?.reason || null,
    original_tokens: o.compression?.original_tokens ?? rec.compression?.original_tokens ?? null,
    retained_tokens: o.compression?.retained_tokens ?? rec.compression?.retained_tokens ?? null,
    compress_mode: o.compression?.mode || rec.compression?.strategy || null,
    ttft_ms: o.provider?.ttft_ms ?? null,
    latency_ms: o.latency_ms ?? rec.latency_ms ?? null,
    retries: o.provider?.retries ?? 0,
    list_usd: o.cost?.list_usd ?? null,
    charged_usd: o.cost?.charged_usd ?? rec.actual_usd ?? null,
    saved_routing_usd: o.cost?.saved_routing_usd ?? null,
    saved_compression_usd: o.cost?.saved_compression_usd ?? null,
  };
}

module.exports = {
  OBS_VERSION,
  ERROR_CODES,
  errorCode,
  httpStatusFor,
  baselineModel,
  computeCost,
  buildRequestObs,
  obsRow,
  safeToken,
};
