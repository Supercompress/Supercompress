"use strict";

/**
 * Config-first model catalog for post-compress routing.
 * Prices are illustrative USD / 1M tokens for eligibility math — not live billing.
 */

const DEFAULT_CATALOG = [
  {
    id: "gpt-4o-mini",
    provider: "openai",
    max_context_tokens: 128_000,
    input_usd_per_mtok: 0.15,
    output_usd_per_mtok: 0.6,
    capabilities: ["chat", "tools"],
    health: "up",
    weight: 3,
    latency_ms_p50: 450,
    tier: 1,
    tags: ["cheap", "fast"],
  },
  {
    id: "gpt-4o",
    provider: "openai",
    max_context_tokens: 128_000,
    input_usd_per_mtok: 2.5,
    output_usd_per_mtok: 10,
    capabilities: ["chat", "tools", "vision"],
    health: "up",
    weight: 2,
    latency_ms_p50: 900,
    tier: 3,
    tags: ["flagship", "vision"],
  },
  {
    id: "claude-sonnet-4",
    provider: "anthropic",
    max_context_tokens: 200_000,
    input_usd_per_mtok: 3,
    output_usd_per_mtok: 15,
    capabilities: ["chat", "tools"],
    health: "up",
    weight: 2,
    latency_ms_p50: 1100,
    tier: 3,
    tags: ["flagship"],
  },
  {
    id: "claude-haiku-3.5",
    provider: "anthropic",
    max_context_tokens: 200_000,
    input_usd_per_mtok: 0.8,
    output_usd_per_mtok: 4,
    capabilities: ["chat", "tools"],
    health: "up",
    weight: 2,
    latency_ms_p50: 500,
    tier: 1,
    tags: ["cheap", "fast"],
  },
  {
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
  },
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

function defaultCatalog() {
  return normalizeCatalog(DEFAULT_CATALOG);
}

module.exports = {
  DEFAULT_CATALOG,
  normalizeModelEntry,
  normalizeCatalog,
  defaultCatalog,
};
