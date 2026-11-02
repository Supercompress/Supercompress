"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  selectRoute,
  nextFallback,
  isRetryableProviderError,
  evaluateEligibility,
  estimateRequestUsd,
  normalizeCatalog,
} = require("./router");
const { DEFAULT_CATALOG, STUB_MODEL } = require("./catalog");

describe("control-plane router", () => {
  it("routes to cheapest fit after compress shrinks context", () => {
    const decision = selectRoute({
      requested_model: "gpt-4o",
      retained_tokens: 2_000,
      policy: {
        version: 1,
        allow_models: ["gpt-4o", "gpt-4o-mini"],
        max_usd_per_request: 1,
        routing: { strategy: "cheapest_fit", fallbacks: ["gpt-4o-mini"] },
      },
    });
    assert.equal(decision.allow, true);
    assert.equal(decision.model, "gpt-4o-mini");
    assert.equal(decision.reason, "cheapest_fit");
    assert.ok(decision.eligibility.some((e) => e.model === "gpt-4o" && e.fit));
    assert.ok(decision.fallback_chain.includes("gpt-4o-mini"));
  });

  it("rejects models that cannot fit post-keep size", () => {
    const tiny = normalizeCatalog([
      {
        id: "tiny",
        provider: "x",
        max_context_tokens: 1000,
        input_usd_per_mtok: 0.01,
        output_usd_per_mtok: 0.01,
        capabilities: ["chat"],
      },
      {
        id: "big",
        provider: "x",
        max_context_tokens: 200_000,
        input_usd_per_mtok: 1,
        output_usd_per_mtok: 1,
        capabilities: ["chat"],
      },
    ]);
    const decision = selectRoute({
      requested_model: "tiny",
      retained_tokens: 50_000,
      catalog: tiny.models,
      policy: {
        version: 1,
        allow_models: ["tiny", "big"],
        routing: { strategy: "prefer_order", prefer: ["tiny", "big"], output_tokens_reserve: 100 },
      },
    });
    assert.equal(decision.model, "big");
    const tinyElig = decision.eligibility.find((e) => e.model === "tiny");
    assert.equal(tinyElig.fit, false);
    assert.ok(tinyElig.reasons.some((r) => r.startsWith("context_overflow")));
  });

  it("honors deny_models and health_down", () => {
    const decision = selectRoute({
      requested_model: "gpt-4o",
      retained_tokens: 1000,
      health: { "gpt-4o-mini": "down" },
      policy: {
        version: 1,
        allow_models: ["gpt-4o", "gpt-4o-mini", "claude-haiku-5-5"],
        deny_models: ["gpt-4o"],
        routing: { strategy: "cheapest_fit", fallbacks: ["gpt-4o-mini", "claude-haiku-5-5"] },
      },
    });
    assert.equal(decision.model, "claude-haiku-5-5");
    assert.ok(decision.eligibility.find((e) => e.model === "gpt-4o-mini").reasons.includes("health_down"));
  });

  it("require_capabilities filters vision-only needs", () => {
    const decision = selectRoute({
      retained_tokens: 500,
      require_capabilities: ["vision"],
      policy: {
        version: 1,
        allow_models: ["gpt-4o-mini", "gpt-4o"],
        routing: { strategy: "cheapest_fit" },
      },
    });
    assert.equal(decision.model, "gpt-4o");
  });

  it("fixed strategy keeps requested when it fits", () => {
    const decision = selectRoute({
      requested_model: "claude-sonnet-5-5",
      retained_tokens: 1000,
      policy: {
        version: 1,
        allow_models: ["claude-sonnet-5-5", "gpt-4o-mini"],
        max_usd_per_request: 50,
        routing: { strategy: "fixed", fallbacks: ["gpt-4o-mini"] },
      },
    });
    assert.equal(decision.model, "claude-sonnet-5-5");
    assert.equal(decision.reason, "requested_fit");
  });

  it("no_viable_model when everything overflows budget", () => {
    const decision = selectRoute({
      requested_model: "gpt-4o",
      retained_tokens: 100_000,
      output_tokens_est: 10_000,
      policy: {
        version: 1,
        allow_models: ["gpt-4o"],
        max_usd_per_request: 0.01,
        routing: { strategy: "fixed" },
      },
    });
    assert.equal(decision.allow, false);
    assert.equal(decision.model, null);
    assert.equal(decision.error.message, "no_viable_model");
  });

  it("nextFallback walks chain and respects max_retries", () => {
    const decision = selectRoute({
      retained_tokens: 500,
      policy: {
        version: 1,
        allow_models: ["gpt-4o", "gpt-4o-mini", "claude-haiku-5-5"],
        routing: {
          strategy: "prefer_order",
          prefer: ["gpt-4o", "gpt-4o-mini", "claude-haiku-5-5"],
          fallbacks: ["gpt-4o-mini", "claude-haiku-5-5"],
          max_retries: 1,
        },
      },
    });
    assert.ok(decision.fallback_chain.length >= 2);
    const a0 = nextFallback(decision, 0);
    const a1 = nextFallback(decision, 1);
    const a2 = nextFallback(decision, 2);
    assert.equal(a0.model, decision.fallback_chain[0]);
    assert.equal(a1.model, decision.fallback_chain[1]);
    // max_retries=1 → index 2 blocked even if chain longer
    assert.equal(a2, null);
  });

  it("isRetryableProviderError detects 429/5xx", () => {
    assert.equal(isRetryableProviderError({ status: 429 }), true);
    assert.equal(isRetryableProviderError({ status: 503 }), true);
    assert.equal(isRetryableProviderError({ status: 400 }), false);
    assert.equal(isRetryableProviderError({ message: "rate limit" }), true);
  });

  it("default catalog never contains the stub model", () => {
    assert.equal(normalizeCatalog(DEFAULT_CATALOG).get("stub-model"), null);
    const d = selectRoute({ retained_tokens: 500, policy: { version: 1 } });
    assert.notEqual(d.model, "stub-model");
  });

  it("long-context pricing applies above the threshold", () => {
    const haiku = DEFAULT_CATALOG.find((x) => x.id === "claude-haiku-5-5");
    assert.equal(estimateRequestUsd(haiku, 80_000, 0), 0.008);
    assert.equal(estimateRequestUsd(haiku, 224_000, 0), 0.112);
  });

  it("fallbacks follow the configured order and never step down a tier", () => {
    const d = selectRoute({
      requested_model: "gpt-4o",
      retained_tokens: 500,
      policy: {
        version: 1,
        allow_models: ["gpt-4o", "gpt-4o-mini", "claude-sonnet-5-5", "claude-haiku-5-5"],
        routing: { strategy: "fixed", fallbacks: ["claude-sonnet-5-5"] },
      },
    });
    assert.deepEqual(d.fallback_chain.slice(0, 2), ["gpt-4o", "claude-sonnet-5-5"]);
    assert.ok(!d.fallback_chain.includes("gpt-4o-mini"));
  });

  it("estimateRequestUsd is deterministic", () => {
    const m = DEFAULT_CATALOG.find((x) => x.id === "gpt-4o-mini");
    const usd = estimateRequestUsd(m, 1_000_000, 0);
    assert.equal(usd, 0.15);
  });

  it("evaluateEligibility marks overflow", () => {
    const m = normalizeCatalog([STUB_MODEL]).get("stub-model");
    const elig = evaluateEligibility(m, {
      retained_tokens: 40_000,
      output_tokens_reserve: 0,
    });
    assert.equal(elig.fit, false);
  });
});
