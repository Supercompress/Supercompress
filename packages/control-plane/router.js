"use strict";

/**
 * Phase 3 — post-compress deterministic router.
 * Config over cleverness. No ML. Uses retained token sizes from Compression Trace.
 */

const { normalizeCatalog, defaultCatalog } = require("./catalog");
const { normalizePolicy } = require("./policy");

const STRATEGIES = new Set(["cheapest_fit", "prefer_order", "fixed"]);

function normalizeRouting(raw = {}) {
  const strategy = STRATEGIES.has(raw.strategy) ? raw.strategy : "cheapest_fit";
  return {
    strategy,
    prefer: Array.isArray(raw.prefer) ? raw.prefer.map(String) : [],
    fallbacks: Array.isArray(raw.fallbacks) ? raw.fallbacks.map(String) : [],
    max_retries: raw.max_retries != null ? Math.max(0, Number(raw.max_retries) || 0) : 1,
    require_capabilities: Array.isArray(raw.require_capabilities)
      ? raw.require_capabilities.map(String)
      : [],
    // reserved tokens for completion so context fit isn't razor-edge
    output_tokens_reserve: Math.max(0, Number(raw.output_tokens_reserve) || 500),
  };
}

function estimateRequestUsd(model, retainedTokens, outputTokensEst) {
  const inTok = Math.max(0, Number(retainedTokens) || 0);
  const outTok = Math.max(0, Number(outputTokensEst) || 0);
  const usd =
    (inTok / 1e6) * Number(model.input_usd_per_mtok || 0) +
    (outTok / 1e6) * Number(model.output_usd_per_mtok || 0);
  return Math.round(usd * 1e6) / 1e6;
}

/**
 * Eligibility for one catalog model against post-compress request shape.
 */
function evaluateEligibility(model, opts = {}) {
  const reasons = [];
  let fit = true;
  const retained = Math.max(0, Number(opts.retained_tokens) || 0);
  const reserve = Math.max(0, Number(opts.output_tokens_reserve) || 0);
  const need = retained + reserve;
  if (need > model.max_context_tokens) {
    fit = false;
    reasons.push(`context_overflow:${need}>${model.max_context_tokens}`);
  }
  const caps = opts.require_capabilities || [];
  for (const c of caps) {
    if (!model.capabilities.includes(c)) {
      fit = false;
      reasons.push(`missing_capability:${c}`);
    }
  }
  const health = opts.health_override || model.health || "up";
  if (health === "down") {
    fit = false;
    reasons.push("health_down");
  } else if (health === "degraded") {
    reasons.push("health_degraded");
  }
  const est = estimateRequestUsd(model, retained, opts.output_tokens_est ?? reserve);
  if (
    opts.max_usd_per_request != null &&
    Number.isFinite(Number(opts.max_usd_per_request)) &&
    est > Number(opts.max_usd_per_request)
  ) {
    fit = false;
    reasons.push(`max_usd:${est}>${opts.max_usd_per_request}`);
  }
  if (fit && !reasons.length) reasons.push("ok");
  return {
    model: model.id,
    fit,
    reasons,
    estimated_usd: est,
    health,
    max_context_tokens: model.max_context_tokens,
  };
}

function uniqueIds(ids) {
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Build ordered candidate ids from request + policy routing + catalog.
 */
function buildCandidateOrder({ requested_model, policy, routing, catalog }) {
  const allow = policy.allow_models;
  const deny = new Set(policy.deny_models || []);
  const prefer = routing.prefer || [];
  const fallbacks = routing.fallbacks || [];
  const requested = requested_model ? String(requested_model) : null;

  let ordered = [];
  if (routing.strategy === "fixed" && requested) {
    ordered = [requested, ...fallbacks];
  } else if (routing.strategy === "prefer_order") {
    ordered = [...prefer, requested, ...fallbacks, ...catalog.models.map((m) => m.id)].filter(
      Boolean
    );
  } else {
    // cheapest_fit: still consider requested first, then prefer, then rest of catalog
    ordered = [requested, ...prefer, ...fallbacks, ...catalog.models.map((m) => m.id)].filter(
      Boolean
    );
  }

  ordered = uniqueIds(ordered);
  return ordered.filter((id) => {
    if (deny.has(id)) return false;
    if (allow?.length && !allow.includes(id)) return false;
    return catalog.get(id) != null;
  });
}

/**
 * Select model after compress.
 * @returns {RouteDecision}
 */
function selectRoute(input = {}) {
  const policy = normalizePolicy(input.policy || {});
  const routing = normalizeRouting({
    ...(policy.routing || {}),
    ...(input.routing || {}),
  });
  const catalog = input.catalog
    ? normalizeCatalog(input.catalog)
    : input.catalogNormalized || defaultCatalog();
  const retained = Math.max(0, Number(input.retained_tokens) || 0);
  const healthMap = input.health && typeof input.health === "object" ? input.health : {};
  const requireCaps =
    (input.require_capabilities && input.require_capabilities.length
      ? input.require_capabilities
      : routing.require_capabilities) || [];
  const maxUsd =
    input.max_usd_per_request != null
      ? Number(input.max_usd_per_request)
      : policy.max_usd_per_request;
  const outEst = input.output_tokens_est != null ? Number(input.output_tokens_est) : routing.output_tokens_reserve;

  const candidates = buildCandidateOrder({
    requested_model: input.requested_model,
    policy,
    routing,
    catalog,
  });

  const eligibility = [];
  const viable = [];
  for (const id of candidates) {
    const model = catalog.get(id);
    const elig = evaluateEligibility(model, {
      retained_tokens: retained,
      require_capabilities: requireCaps,
      max_usd_per_request: maxUsd,
      output_tokens_reserve: routing.output_tokens_reserve,
      output_tokens_est: outEst,
      health_override: healthMap[id],
    });
    eligibility.push(elig);
    if (elig.fit) viable.push({ id, elig, model });
  }

  let chosen = null;
  let reason = "no_viable_model";
  if (viable.length) {
    if (routing.strategy === "cheapest_fit") {
      viable.sort((a, b) => {
        const d = a.elig.estimated_usd - b.elig.estimated_usd;
        if (d !== 0) return d;
        // stable: earlier in candidate order wins
        return candidates.indexOf(a.id) - candidates.indexOf(b.id);
      });
      chosen = viable[0];
      reason = "cheapest_fit";
    } else {
      // prefer_order / fixed: first viable in candidate order
      chosen = viable[0];
      reason =
        input.requested_model && chosen.id === String(input.requested_model)
          ? "requested_fit"
          : "prefer_order_fit";
    }
  }

  const fallback_chain = viable.map((v) => v.id);
  const decision = {
    model: chosen ? chosen.id : null,
    provider: chosen ? chosen.model.provider : null,
    strategy: routing.strategy,
    reason: chosen ? reason : "no_viable_model",
    retained_tokens: retained,
    estimated_usd: chosen ? chosen.elig.estimated_usd : null,
    candidates_considered: candidates,
    fallback_chain,
    fallback_index: 0,
    max_retries: routing.max_retries,
    eligibility,
    allow: Boolean(chosen),
  };

  if (!chosen) {
    decision.error = {
      class: "rejected",
      message: "no_viable_model",
      reasons: eligibility.flatMap((e) => e.reasons).slice(0, 20),
    };
  }
  return decision;
}

/**
 * Advance to next fallback after provider failure (429/5xx).
 * Returns null if exhausted.
 */
function nextFallback(decision, attemptIndex) {
  if (!decision || !Array.isArray(decision.fallback_chain)) return null;
  const idx = Number(attemptIndex);
  if (!Number.isFinite(idx) || idx < 0) return null;
  if (idx >= decision.fallback_chain.length) return null;
  if (idx > decision.max_retries) return null;
  const model = decision.fallback_chain[idx];
  return {
    ...decision,
    model,
    fallback_index: idx,
    reason: idx === 0 ? decision.reason : `fallback_${idx}`,
  };
}

/**
 * Whether a provider error should trigger fallback retry.
 */
function isRetryableProviderError(err) {
  if (!err) return false;
  const status = Number(err.status || err.statusCode || err.httpStatus);
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  const code = String(err.code || err.message || "").toLowerCase();
  return (
    code.includes("429") ||
    code.includes("rate") ||
    code.includes("timeout") ||
    code.includes("unavailable") ||
    code.includes("5xx") ||
    code.includes("econnreset")
  );
}

module.exports = {
  normalizeRouting,
  estimateRequestUsd,
  evaluateEligibility,
  buildCandidateOrder,
  selectRoute,
  nextFallback,
  isRetryableProviderError,
  defaultCatalog,
  normalizeCatalog,
};
