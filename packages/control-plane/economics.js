"use strict";

/**
 * Compression → routing economics (the SuperCompress moat).
 *
 * LiteLLM routes on the request the client sent.
 * We route on the request *after* keep — and prove the $ delta.
 */

const { selectRoute, estimateRequestUsd } = require("./router");
const { defaultCatalog, normalizeCatalog } = require("./catalog");
const { normalizePolicy } = require("./policy");

/**
 * Compare route decision as-if uncompressed vs post-compress retained size.
 */
function computeRouteEconomics(input = {}) {
  const catalog = input.catalog
    ? normalizeCatalog(input.catalog)
    : input.catalogNormalized || defaultCatalog();
  const policy = normalizePolicy(input.policy || {});
  const original = Math.max(0, Number(input.original_tokens) || 0);
  const retained = Math.max(0, Number(input.retained_tokens) || 0);
  const requested = input.requested_model;
  const common = {
    requested_model: requested,
    policy,
    catalog: catalog.models,
    health: input.health,
    require_capabilities: input.require_capabilities,
    max_usd_per_request: input.max_usd_per_request,
    routing: input.routing,
    output_tokens_est: input.output_tokens_est,
  };

  const without = selectRoute({ ...common, retained_tokens: original });
  const withC = selectRoute({ ...common, retained_tokens: retained });

  const usdWithout = without.estimated_usd != null ? Number(without.estimated_usd) : null;
  const usdWith = withC.estimated_usd != null ? Number(withC.estimated_usd) : null;
  const dollarsSaved =
    usdWithout != null && usdWith != null
      ? Math.round(Math.max(0, usdWithout - usdWith) * 1e6) / 1e6
      : 0;

  return {
    original_tokens: original,
    retained_tokens: retained,
    tokens_saved: Math.max(0, original - retained),
    without_compress: {
      model: without.model,
      provider: without.provider,
      estimated_usd: usdWithout,
      reason: without.reason,
      allow: without.allow,
    },
    with_compress: {
      model: withC.model,
      provider: withC.provider,
      estimated_usd: usdWith,
      reason: withC.reason,
      allow: withC.allow,
    },
    dollars_saved_est: dollarsSaved,
    model_changed: Boolean(
      without.model && withC.model && without.model !== withC.model
    ),
    unlocks_smaller_context_model: Boolean(
      without.allow === false && withC.allow === true
    ),
  };
}

/**
 * Enrich a CompressionTrace with route economics + dollars avoided.
 */
function attachEconomicsToTrace(trace, economics, opts = {}) {
  if (!trace || typeof trace !== "object") return trace;
  const usdPerMTok = opts.usdPerMTok != null ? Number(opts.usdPerMTok) : 0.15;
  const tokenAvoided =
    Math.max(0, (trace.original_tokens || 0) - (trace.retained_tokens || 0)) / 1e6;
  const tokenDollars = Math.round(tokenAvoided * usdPerMTok * 1e6) / 1e6;
  const routeDollars = Number(economics?.dollars_saved_est) || 0;
  return {
    ...trace,
    dollars_avoided_est: Math.round((tokenDollars + routeDollars) * 1e6) / 1e6,
    meta: {
      ...(trace.meta || {}),
      economics,
      dollars_avoided_tokens_est: tokenDollars,
      dollars_avoided_route_est: routeDollars,
    },
  };
}

module.exports = {
  computeRouteEconomics,
  attachEconomicsToTrace,
  estimateRequestUsd,
};
