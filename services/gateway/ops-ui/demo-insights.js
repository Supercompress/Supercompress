"use strict";

/**
 * Offline demo insights for the ops UI — honest math via computeRouteEconomics.
 * No asks/prompts. Confidential until launch.
 */

const { computeRouteEconomics } = require("../../../packages/control-plane/economics");
const { buildOpsInsights } = require("../../../packages/control-plane/insights");
const { buildCompressionTrace } = require("../../../packages/control-plane/compression-trace");
const { attachEconomicsToTrace } = require("../../../packages/control-plane/economics");
const { computeCost } = require("../../../packages/control-plane/request-obs");

const DEMO_CATALOG = [
  {
    id: "tiny-fit",
    provider: "stub",
    max_context_tokens: 8_000,
    input_usd_per_mtok: 0.15,
    output_usd_per_mtok: 0.6,
    capabilities: ["chat"],
    health: "up",
  },
  {
    id: "mid-fit",
    provider: "openai",
    max_context_tokens: 32_000,
    input_usd_per_mtok: 0.5,
    output_usd_per_mtok: 1.5,
    capabilities: ["chat", "tools"],
    health: "up",
  },
  {
    id: "flagship",
    provider: "openai",
    max_context_tokens: 200_000,
    input_usd_per_mtok: 2.5,
    output_usd_per_mtok: 10,
    capabilities: ["chat", "tools", "vision"],
    health: "up",
  },
];

const SCENARIOS = [
  { original: 48_000, retained: 5_200, agent: "support-bot", ms: 140, unlock: true },
  { original: 92_000, retained: 7_100, agent: "rag-worker", ms: 210, unlock: true },
  { original: 18_000, retained: 6_400, agent: "code-agent", ms: 95 },
  { original: 61_000, retained: 4_800, agent: "support-bot", ms: 160, unlock: true },
  { original: 120_000, retained: 9_900, agent: "research", ms: 280 },
  { original: 9_500, retained: 3_100, agent: "code-agent", ms: 70 },
  { original: 55_000, retained: 5_000, agent: "rag-worker", ms: 190, unlock: true },
  { original: 77_000, retained: 8_200, agent: "research", ms: 230 },
];

/** Catalog where raw context overflows every model — keep is the only way in. */
const UNLOCK_CATALOG = [
  {
    id: "edge-small",
    provider: "stub",
    max_context_tokens: 8_000,
    input_usd_per_mtok: 0.15,
    output_usd_per_mtok: 0.6,
    capabilities: ["chat"],
    health: "up",
  },
  {
    id: "edge-mid",
    provider: "openai",
    max_context_tokens: 16_000,
    input_usd_per_mtok: 0.5,
    output_usd_per_mtok: 1.5,
    capabilities: ["chat", "tools"],
    health: "up",
  },
];

function buildDemoRecords(opts = {}) {
  const now = Date.now();
  const catalog = opts.catalog || DEMO_CATALOG;
  const policy = {
    routing: { strategy: "cheapest_fit", output_tokens_reserve: 500 },
  };

  return SCENARIOS.map((s, i) => {
    const cat = s.unlock ? UNLOCK_CATALOG : catalog;
    const econ = computeRouteEconomics({
      original_tokens: s.original,
      retained_tokens: s.retained,
      catalog: cat,
      policy,
    });
    let trace = buildCompressionTrace({
      original_tokens: s.original,
      retained_tokens: s.retained,
      strategy: "neural_keep",
    });
    trace = attachEconomicsToTrace(trace, econ, { usdPerMTok: 0.15 });
    const auto = i % 2 === 0;
    const routed = econ.with_compress?.model;
    // A named model is served as named; only "auto" lets the router pick.
    const requested = auto ? "auto" : routed;
    const outTok = 400 + i * 50;
    const allModels = [...catalog, ...UNLOCK_CATALOG];
    const cost = computeCost({
      catalog: allModels,
      requested,
      routed,
      inputTokens: s.retained,
      outputTokens: outTok,
      tokensSaved: s.original - s.retained,
      chargedUsd: econ.with_compress?.estimated_usd ?? 0.01,
    });
    const fellBack = i === 3;
    const obs = {
      v: 1,
      request_id: `req_demo_${String(i + 1).padStart(3, "0")}`,
      stream: i % 3 === 0,
      latency_ms: s.ms + 900,
      routing: {
        requested_model: requested,
        model: routed,
        provider: econ.with_compress?.provider,
        mode: auto ? "auto" : "passthrough",
        strategy: auto ? "cheapest_fit" : "fixed",
        reason: auto ? "complexity_band" : "requested_model",
        classifier: auto ? { tier: 1 + (i % 3), category: "code", difficulty: "medium", reasons: ["simple_default"], difficulty_score: null } : null,
      },
      compression: {
        engine: "neural_keep",
        mode: "neural_keep",
        original_tokens: s.original,
        retained_tokens: s.retained,
        tokens_saved: s.original - s.retained,
        ratio: trace.ratio,
        passthrough_reason: null,
        latency_ms: s.ms,
      },
      provider: {
        name: econ.with_compress?.provider,
        model: routed,
        status: "ok",
        ttft_ms: i % 3 === 0 ? 300 + i * 20 : null,
        latency_ms: 900,
        input_tokens: s.retained,
        output_tokens: outTok,
        cached_input_tokens: 0,
        usage_estimated: false,
        finish_reason: "stop",
        attempts: fellBack ? 2 : 1,
        retries: fellBack ? 1 : 0,
        fallbacks: fellBack ? [{ provider: "openai", model: "flagship", http_status: 503, code: "provider_error", ms: 120 }] : [],
      },
      cost,
      error: null,
    };
    return {
      id: `req_demo_${String(i + 1).padStart(3, "0")}`,
      org_id: opts.org_id || "demo_org",
      agent_id: s.agent,
      key_id: "demo_key",
      status: "finalized",
      created_at: new Date(now - (SCENARIOS.length - i) * 60_000).toISOString(),
      updated_at: new Date(now - (SCENARIOS.length - i) * 60_000 + s.ms).toISOString(),
      actual_usd: econ.with_compress?.estimated_usd ?? 0.01,
      reserved_usd: 1,
      latency_ms: s.ms,
      model_requested: s.unlock ? "edge-mid" : "flagship",
      model_routed: econ.with_compress?.model,
      provider: econ.with_compress?.provider,
      compression: trace,
      meta: { obs },
    };
  }).concat([
    {
      id: "req_demo_009",
      org_id: opts.org_id || "demo_org",
      agent_id: "support-bot",
      key_id: "demo_key",
      status: "finalized",
      created_at: new Date(now - 30_000).toISOString(),
      updated_at: new Date(now - 30_000 + 12).toISOString(),
      latency_ms: 12,
      model_requested: "flagship",
      error_class: "rejected",
      error_message: "credits_required",
      compression: null,
      meta: {
        obs: {
          v: 1,
          request_id: "req_demo_009",
          stream: false,
          latency_ms: 12,
          routing: { requested_model: "flagship", model: null, provider: null, mode: "passthrough", strategy: null, reason: null, classifier: null },
          compression: null,
          provider: null,
          cost: { list_usd: 0, charged_usd: 0 },
          error: { code: "credits_required", http_status: 402, class: "rejected" },
        },
      },
    },
  ]).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function buildDemoInsights(opts = {}) {
  const records = buildDemoRecords(opts);
  const insights = buildOpsInsights(records, {
    org_id: opts.org_id || "demo_org",
    budget_usd: opts.budget_usd ?? 5,
  });
  return {
    ...insights,
    demo: true,
    confidential: true,
    comparison: {
      litellm: {
        routes_on: "client-sent context (pre-compress)",
        sees_compression: false,
        sees_route_unlock: false,
      },
      supercompress: {
        routes_on: "post-keep retained tokens",
        sees_compression: true,
        sees_route_unlock: true,
        dollars_avoided_total_est: insights.moat.dollars_avoided_total_est,
        unlock_count: insights.moat.unlock_count,
        model_changed_count: insights.moat.model_changed_count,
      },
    },
    records_preview: records.filter((r) => r.compression).slice(0, 8).map((r) => ({
      id: r.id,
      agent_id: r.agent_id,
      model_routed: r.model_routed,
      original_tokens: r.compression.original_tokens,
      retained_tokens: r.compression.retained_tokens,
      dollars_avoided_est: r.compression.dollars_avoided_est,
      model_changed: Boolean(r.compression.meta?.economics?.model_changed),
      latency_ms: r.latency_ms,
      created_at: r.created_at,
    })),
  };
}

module.exports = {
  buildDemoInsights,
  buildDemoRecords,
  DEMO_CATALOG,
  SCENARIOS,
};
