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
      requested_model: "gpt-6.1-sol",
      retained_tokens: 2_000,
      policy: {
        version: 1,
        allow_models: ["gpt-6.1-sol", "gpt-6-luna"],
        max_usd_per_request: 1,
        routing: { strategy: "cheapest_fit", fallbacks: ["gpt-6-luna"] },
      },
    });
    assert.equal(decision.allow, true);
    assert.equal(decision.model, "gpt-6-luna");
    assert.equal(decision.reason, "cheapest_fit");
    assert.ok(decision.eligibility.some((e) => e.model === "gpt-6.1-sol" && e.fit));
    assert.ok(decision.fallback_chain.includes("gpt-6-luna"));
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
      requested_model: "gpt-6.1-sol",
      retained_tokens: 1000,
      health: { "gpt-6-luna": "down" },
      policy: {
        version: 1,
        allow_models: ["gpt-6.1-sol", "gpt-6-luna", "claude-haiku-5-5"],
        deny_models: ["gpt-6.1-sol"],
        routing: { strategy: "cheapest_fit", fallbacks: ["gpt-6-luna", "claude-haiku-5-5"] },
      },
    });
    assert.equal(decision.model, "claude-haiku-5-5");
    assert.ok(decision.eligibility.find((e) => e.model === "gpt-6-luna").reasons.includes("health_down"));
  });

  it("require_capabilities filters vision-only needs", () => {
    const decision = selectRoute({
      retained_tokens: 500,
      require_capabilities: ["vision"],
      catalog: [
        { ...DEFAULT_CATALOG.find((x) => x.id === "gpt-6-luna"), capabilities: ["chat", "tools"] },
        DEFAULT_CATALOG.find((x) => x.id === "gpt-6.1-sol"),
      ],
      policy: {
        version: 1,
        allow_models: ["gpt-6-luna", "gpt-6.1-sol"],
        routing: { strategy: "cheapest_fit" },
      },
    });
    assert.equal(decision.model, "gpt-6.1-sol");
  });

  it("fixed strategy keeps requested when it fits", () => {
    const decision = selectRoute({
      requested_model: "claude-sonnet-5-5",
      retained_tokens: 1000,
      policy: {
        version: 1,
        allow_models: ["claude-sonnet-5-5", "gpt-6-luna"],
        max_usd_per_request: 50,
        routing: { strategy: "fixed", fallbacks: ["gpt-6-luna"] },
      },
    });
    assert.equal(decision.model, "claude-sonnet-5-5");
    assert.equal(decision.reason, "requested_fit");
  });

  it("no_viable_model when everything overflows budget", () => {
    const decision = selectRoute({
      requested_model: "gpt-6.1-sol",
      retained_tokens: 100_000,
      output_tokens_est: 10_000,
      policy: {
        version: 1,
        allow_models: ["gpt-6.1-sol"],
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
        allow_models: ["gpt-6.1-sol", "gpt-6-luna", "claude-haiku-5-5"],
        routing: {
          strategy: "prefer_order",
          prefer: ["gpt-6.1-sol", "gpt-6-luna", "claude-haiku-5-5"],
          fallbacks: ["gpt-6-luna", "claude-haiku-5-5"],
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
      requested_model: "gpt-6.1-sol",
      retained_tokens: 500,
      policy: {
        version: 1,
        allow_models: ["gpt-6.1-sol", "gpt-6-luna", "claude-sonnet-5-5", "claude-haiku-5-5"],
        routing: { strategy: "fixed", fallbacks: ["claude-sonnet-5-5"] },
      },
    });
    assert.deepEqual(d.fallback_chain.slice(0, 2), ["gpt-6.1-sol", "claude-sonnet-5-5"]);
    assert.ok(!d.fallback_chain.includes("gpt-6-luna"));
  });

  it("estimateRequestUsd is deterministic", () => {
    const m = DEFAULT_CATALOG.find((x) => x.id === "gpt-6-luna");
    const usd = estimateRequestUsd(m, 200_000, 0);
    assert.equal(usd, 0.02);
  });

  it("evaluateEligibility marks overflow", () => {
    const m = normalizeCatalog([STUB_MODEL]).get("stub-model");
    const elig = evaluateEligibility(m, {
      retained_tokens: 40_000,
      output_tokens_reserve: 0,
    });
    assert.equal(elig.fit, false);
  });

  describe("complexity routing", () => {
    const route = (request_tier, { routing = {}, ...extra } = {}) =>
      selectRoute({
        catalog: DEFAULT_CATALOG,
        retained_tokens: 2000,
        output_tokens_est: 500,
        routing: { strategy: "cheapest_fit", complexity_routing: true, ...routing },
        request_tier,
        ...extra,
      });
    const tierOf = (id) => DEFAULT_CATALOG.find((m) => m.id === id).tier;

    it("serves each task from the cheapest model in the lowest tier that clears it", () => {
      assert.equal(tierOf(route(0).model), 1);
      assert.equal(tierOf(route(1).model), 1);
      assert.equal(route(2).model, "gpt-6.1-terra");
      const hard = route(3);
      assert.equal(tierOf(hard.model), 3);
      assert.equal(hard.model, "claude-opus-5-5");
      assert.equal(hard.band_tier, 3);
      assert.equal(hard.below_request_tier, false);
    });

    it("never falls back below the band", () => {
      const d = route(2);
      for (const id of d.fallback_chain) assert.ok(tierOf(id) >= 2, `${id} in ${d.fallback_chain}`);
      // Its own tier first, then higher tiers.
      const tiers = d.fallback_chain.map(tierOf);
      assert.deepEqual(tiers, [...tiers].sort((a, b) => a - b));
    });

    it("operator fallbacks below the band are skipped", () => {
      const d = route(3, { routing: { fallbacks: ["gpt-6-luna"] } });
      assert.ok(!d.fallback_chain.includes("gpt-6-luna"));
    });

    it("bands prefer_order and fixed too, so a preference never serves hard work cheap", () => {
      const prefer = route(3, { routing: { strategy: "prefer_order", prefer: ["gpt-6-luna"] } });
      assert.equal(tierOf(prefer.model), 3);
      assert.equal(prefer.below_request_tier, false);
      const fixed = route(3, {
        requested_model: "auto",
        routing: { strategy: "fixed", fallbacks: ["gpt-6-luna"] },
      });
      // Nothing listed clears the grade: served anyway, and the decision says so.
      assert.equal(fixed.model, "gpt-6-luna");
      assert.equal(fixed.below_request_tier, true);
    });

    it("a higher-tier operator fallback waits until the chosen tier is exhausted", () => {
      const d = route(1, { routing: { fallbacks: ["gpt-6-astra"] } });
      const tiers = d.fallback_chain.map(tierOf);
      assert.deepEqual(tiers, [...tiers].sort((a, b) => a - b));
      assert.equal(tierOf(d.fallback_chain[1]), 1);
      // Within tier 3 the operator's pick comes first.
      assert.equal(d.fallback_chain.find((id) => tierOf(id) === 3), "gpt-6-astra");
    });

    it("a hard task with only small models viable is served by the strongest and flagged", () => {
      const small = DEFAULT_CATALOG.filter((m) => m.tier === 1);
      const d = selectRoute({ catalog: small, retained_tokens: 100, routing: { complexity_routing: true }, request_tier: 3 });
      assert.equal(d.allow, true);
      assert.equal(d.below_request_tier, true);
    });

    it("a down model in the band is routed around, staying in the band", () => {
      const d = route(1, { health: { "gpt-6-luna": "down", "claude-haiku-5-5": "down" } });
      assert.equal(d.model, "gpt-6.1-terra");
    });

    it("without complexity routing the request tier is ignored", () => {
      const d = selectRoute({ catalog: DEFAULT_CATALOG, retained_tokens: 2000, routing: { strategy: "cheapest_fit" }, request_tier: 3 });
      assert.equal(tierOf(d.model), 1);
      assert.equal(d.band_tier, null);
    });
  });
});
