"use strict";

/**
 * Config-first model catalog for post-compress routing.
 * Prices are illustrative USD / 1M tokens for eligibility math — not live billing.
 *
 * `tier` is the capability band complexity routing ("auto") serves from: a task the
 * classifier grades N goes to the cheapest viable model of the lowest tier >= N.
 *   1 small/fast (renames, docs, commit messages, summaries)
 *   2 balanced   (ordinary features, tests, wiring, unclear asks)
 *   3 frontier   (debugging, plans, migrations, reviews, concurrency, edge cases)
 * Put a model in tier 3 only if it is trusted with the hardest tasks: an over-generous
 * tier 3 silently serves hard work from a weaker model.
 */

const DEFAULT_CATALOG = [
  // OpenAI GPT-6 family (reasoning models; prompts above 272K input tokens bill the whole
  // request at the long-context rate). Windows are 1.05M upstream; kept at 1M here.
  {
    id: "gpt-6-luna",
    provider: "openai",
    max_context_tokens: 1_000_000,
    input_usd_per_mtok: 0.1,
    output_usd_per_mtok: 0.5,
    long_context_threshold_tokens: 272_000,
    long_input_usd_per_mtok: 0.2,
    long_output_usd_per_mtok: 0.75,
    // Reasoning tokens count against the cap; 4096 cuts long answers short.
    default_output_tokens: 16_384,
    capabilities: ["chat", "tools", "vision"],
    health: "up",
    weight: 3,
    latency_ms_p50: 500,
    tier: 1,
    tags: ["cheap", "fast", "long-context"],
  },
  {
    id: "gpt-6.1-terra",
    provider: "openai",
    max_context_tokens: 1_000_000,
    input_usd_per_mtok: 1,
    output_usd_per_mtok: 5,
    long_context_threshold_tokens: 272_000,
    long_input_usd_per_mtok: 2,
    long_output_usd_per_mtok: 7.5,
    // Reasoning tokens count against the cap; 4096 cuts long answers short.
    default_output_tokens: 16_384,
    capabilities: ["chat", "tools", "vision"],
    health: "up",
    weight: 2,
    latency_ms_p50: 800,
    tier: 2,
    tags: ["balanced", "long-context"],
  },
  {
    id: "gpt-6.1-sol",
    provider: "openai",
    max_context_tokens: 1_000_000,
    input_usd_per_mtok: 2,
    output_usd_per_mtok: 10,
    long_context_threshold_tokens: 272_000,
    long_input_usd_per_mtok: 4,
    long_output_usd_per_mtok: 15,
    // Reasoning tokens count against the cap; 4096 cuts long answers short.
    default_output_tokens: 16_384,
    capabilities: ["chat", "tools", "vision"],
    health: "up",
    weight: 2,
    latency_ms_p50: 1100,
    tier: 2,
    tags: ["balanced", "long-context"],
  },
  {
    id: "gpt-6-astra",
    provider: "openai",
    max_context_tokens: 1_000_000,
    input_usd_per_mtok: 10,
    output_usd_per_mtok: 50,
    long_context_threshold_tokens: 272_000,
    long_input_usd_per_mtok: 20,
    long_output_usd_per_mtok: 75,
    // Reasoning tokens count against the cap; 4096 cuts long answers short.
    default_output_tokens: 16_384,
    capabilities: ["chat", "tools", "vision"],
    health: "up",
    weight: 1,
    latency_ms_p50: 2000,
    tier: 3,
    tags: ["frontier", "long-context"],
  },
  {
    id: "claude-haiku-5-5",
    provider: "anthropic",
    max_context_tokens: 1_000_000,
    input_usd_per_mtok: 0.1,
    output_usd_per_mtok: 0.5,
    // Prompts above 100K input tokens bill the whole request at the long-context rate.
    long_context_threshold_tokens: 100_000,
    long_input_usd_per_mtok: 0.5,
    long_output_usd_per_mtok: 2.5,
    capabilities: ["chat", "tools", "vision"],
    health: "up",
    weight: 2,
    latency_ms_p50: 500,
    tier: 1,
    tags: ["cheap", "fast", "long-context"],
  },
  {
    id: "claude-sonnet-5-5",
    provider: "anthropic",
    max_context_tokens: 1_000_000,
    input_usd_per_mtok: 2,
    output_usd_per_mtok: 10,
    capabilities: ["chat", "tools", "vision"],
    health: "up",
    weight: 2,
    latency_ms_p50: 1100,
    tier: 2,
    tags: ["balanced", "long-context"],
  },
  {
    id: "claude-opus-5-5",
    provider: "anthropic",
    max_context_tokens: 1_000_000,
    input_usd_per_mtok: 4,
    output_usd_per_mtok: 20,
    capabilities: ["chat", "tools", "vision"],
    health: "up",
    weight: 1,
    latency_ms_p50: 1600,
    tier: 3,
    tags: ["flagship", "long-context"],
  },
  {
    id: "claude-fable-5-2",
    provider: "anthropic",
    max_context_tokens: 1_000_000,
    input_usd_per_mtok: 8,
    output_usd_per_mtok: 40,
    capabilities: ["chat", "tools", "vision"],
    health: "up",
    weight: 1,
    latency_ms_p50: 2500,
    tier: 3,
    tags: ["frontier", "long-context"],
  },
  {
    id: "claude-fable-5-1",
    provider: "anthropic",
    max_context_tokens: 1_000_000,
    input_usd_per_mtok: 10,
    output_usd_per_mtok: 50,
    capabilities: ["chat", "tools", "vision"],
    health: "up",
    weight: 1,
    latency_ms_p50: 2500,
    tier: 3,
    tags: ["frontier", "long-context"],
  },
];

/**
 * Models on the other supported providers (services/gateway/providers/registry.js).
 * The gateway adds an entry only when its provider is configured (API key set), so a
 * deployment never routes to a provider it cannot call. Prices are illustrative, as above;
 * windows are kept conservative so a request the router accepts also fits upstream.
 * Override or extend with SC_CP_CATALOG / SC_CP_CATALOG_FILE.
 */
/**
 * Test-only offline model. Not in DEFAULT_CATALOG: a production catalog must never route
 * real traffic to a model that fabricates answers. Tests pass it explicitly.
 */
const STUB_MODEL = {
  id: "stub-model",
  provider: "stub",
  max_context_tokens: 32_000,
  input_usd_per_mtok: 0.01,
  output_usd_per_mtok: 0.01,
  capabilities: ["chat"],
  health: "up",
  weight: 1,
  latency_ms_p50: 20,
  tier: 0,
  tags: ["stub"],
};

// Tiers here are capped at 2 until each model is evaluated on hard coding work: with a key
// set, a tier-3 entry would win every hard "auto" task on price over Opus/Astra/Fable.
// Promote a model to tier 3 only after it passes that eval.
const PROVIDER_CATALOG = [
  // Gemini 4 Argon is $2/$10 until Nov 30 2026 and $4/$20 from Dec 1; 3.8 Flash is $0.75/$3.75
  // until Dec 31 2026 and $1.50/$7.50 from Jan 1 2027. Update these entries on those dates.
  { id: "gemini-3.8-flash", provider: "google", max_context_tokens: 1_048_576, input_usd_per_mtok: 0.75, output_usd_per_mtok: 3.75, capabilities: ["chat", "tools", "vision"], weight: 2, latency_ms_p50: 600, tier: 1, tags: ["cheap", "fast", "long-context"] },
  { id: "gemini-4-argon", provider: "google", max_context_tokens: 1_000_000, input_usd_per_mtok: 2, output_usd_per_mtok: 10, capabilities: ["chat", "tools", "vision"], weight: 2, latency_ms_p50: 1500, tier: 2, tags: ["flagship", "long-context"] },
  { id: "mistral-small-latest", provider: "mistral", max_context_tokens: 256_000, input_usd_per_mtok: 0.15, output_usd_per_mtok: 0.6, capabilities: ["chat", "tools"], weight: 2, latency_ms_p50: 450, tier: 1, tags: ["cheap", "fast"] },
  { id: "mistral-large-latest", provider: "mistral", max_context_tokens: 256_000, input_usd_per_mtok: 1.36, output_usd_per_mtok: 4.18, capabilities: ["chat", "tools", "vision"], weight: 2, latency_ms_p50: 1000, tier: 2, tags: ["flagship"] },
  // xAI bills the whole request at the long rate once the prompt reaches 200K tokens.
  { id: "grok-4.7", provider: "xai", max_context_tokens: 500_000, input_usd_per_mtok: 2, output_usd_per_mtok: 6, long_context_threshold_tokens: 199_999, long_input_usd_per_mtok: 4, long_output_usd_per_mtok: 12, capabilities: ["chat", "tools"], weight: 2, latency_ms_p50: 1500, tier: 2, tags: ["flagship", "long-context"] },
  // DeepSeek charges double during peak hours (UTC weekdays); priced at peak so we never undercharge.
  { id: "deepseek-flash", provider: "deepseek", max_context_tokens: 1_000_000, input_usd_per_mtok: 0.3, output_usd_per_mtok: 1.2, capabilities: ["chat", "tools"], weight: 2, latency_ms_p50: 900, tier: 1, tags: ["cheap", "long-context"] },
  { id: "deepseek-v4-pro", provider: "deepseek", max_context_tokens: 1_000_000, input_usd_per_mtok: 1.32, output_usd_per_mtok: 3.96, capabilities: ["chat", "tools"], weight: 2, latency_ms_p50: 1500, tier: 2, tags: ["flagship", "long-context"] },
  { id: "groq/gpt-oss-120b", upstream_model: "openai/gpt-oss-120b", provider: "groq", max_context_tokens: 131_072, input_usd_per_mtok: 0.15, output_usd_per_mtok: 0.6, capabilities: ["chat", "tools"], weight: 2, latency_ms_p50: 300, tier: 2, tags: ["fast", "open-weights"] },
];

function normalizeModelEntry(raw = {}) {
  const id = String(raw.id || "").trim();
  if (!id) {
    const err = new Error("catalog_model_missing_id");
    err.code = "catalog_model_missing_id";
    throw err;
  }
  const health = ["up", "degraded", "down"].includes(raw.health) ? raw.health : "up";
  return {
    id,
    provider: String(raw.provider || "unknown"),
    max_context_tokens: Math.max(1, Number(raw.max_context_tokens) || 1),
    input_usd_per_mtok: Math.max(0, Number(raw.input_usd_per_mtok) || 0),
    output_usd_per_mtok: Math.max(0, Number(raw.output_usd_per_mtok) || 0),
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.map(String) : ["chat"],
    health,
    /** Soft routing weight (weighted strategy). Default 1. */
    weight: Math.max(0, Number(raw.weight) || 1),
    /** p50 latency hint in ms (latency_prefer strategy). */
    latency_ms_p50:
      raw.latency_ms_p50 != null ? Math.max(0, Number(raw.latency_ms_p50) || 0) : 800,
    /** 0=edge … 3=flagship. Optional max_tier gate. */
    tier: raw.tier != null ? Math.max(0, Number(raw.tier) || 0) : 1,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    /** Output cap (and hold size) for requests that set no max_tokens. Reasoning models need more. */
    ...(Number(raw.default_output_tokens) > 0
      ? { default_output_tokens: Math.floor(Number(raw.default_output_tokens)) }
      : {}),
    /** Long-context pricing: above this many input tokens the long_* rates apply to the request. */
    ...(raw.long_context_threshold_tokens
      ? {
          long_context_threshold_tokens: Math.max(1, Number(raw.long_context_threshold_tokens) || 0),
          long_input_usd_per_mtok: Math.max(0, Number(raw.long_input_usd_per_mtok) || 0),
          long_output_usd_per_mtok: Math.max(0, Number(raw.long_output_usd_per_mtok) || 0),
        }
      : {}),
    /** Model id sent upstream when it differs from the catalog id (e.g. an OpenRouter slug). */
    ...(raw.upstream_model ? { upstream_model: String(raw.upstream_model) } : {}),
  };
}

/**
 * @param {object[]|object|null} input — array of models, or { models: [...] }
 */
function normalizeCatalog(input) {
  let list = input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    list = input.models || input.catalog || [];
  }
  if (!Array.isArray(list) || list.length === 0) {
    list = DEFAULT_CATALOG;
  }
  const byId = new Map();
  for (const raw of list) {
    const m = normalizeModelEntry(raw);
    byId.set(m.id, m);
  }
  return {
    models: [...byId.values()],
    byId,
    get(id) {
      return byId.get(String(id)) || null;
    },
  };
}

/**
 * USD for one request on this model, using the long-context rates when the prompt is above
 * the model's threshold. Rounded to 1e-6.
 */
function priceUsd(model, inputTokens, outputTokens) {
  const inTok = Math.max(0, Number(inputTokens) || 0);
  const outTok = Math.max(0, Number(outputTokens) || 0);
  const long =
    model &&
    model.long_context_threshold_tokens &&
    inTok > Number(model.long_context_threshold_tokens);
  const inRate = long ? model.long_input_usd_per_mtok : model?.input_usd_per_mtok;
  const outRate = long ? model.long_output_usd_per_mtok : model?.output_usd_per_mtok;
  const usd = (inTok / 1e6) * Number(inRate || 0) + (outTok / 1e6) * Number(outRate || 0);
  return Math.round(usd * 1e6) / 1e6;
}

function defaultCatalog() {
  return normalizeCatalog(DEFAULT_CATALOG);
}

module.exports = {
  DEFAULT_CATALOG,
  PROVIDER_CATALOG,
  STUB_MODEL,
  priceUsd,
  normalizeModelEntry,
  normalizeCatalog,
  defaultCatalog,
};
