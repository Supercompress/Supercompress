"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { computeRouteEconomics, attachEconomicsToTrace } = require("./economics");
const { buildCompressionTrace } = require("./compression-trace");

describe("route economics (compress-then-route moat)", () => {
  it("proves cheaper route after keep on same model", () => {
    const econ = computeRouteEconomics({
      original_tokens: 100_000,
      retained_tokens: 10_000,
      requested_model: "gpt-4o-mini",
      policy: { routing: { strategy: "fixed" } },
    });
    assert.equal(econ.with_compress.model, "gpt-4o-mini");
    assert.equal(econ.without_compress.model, "gpt-4o-mini");
    assert.ok(econ.dollars_saved_est > 0);
    assert.equal(econ.tokens_saved, 90_000);
    assert.equal(econ.model_changed, false);
  });

  it("unlocks fit when uncompressed overflows a small model", () => {
    const catalog = [
      {
        id: "tiny",
        provider: "stub",
        max_context_tokens: 8_000,
        input_usd_per_mtok: 0.1,
        output_usd_per_mtok: 0.1,
        capabilities: ["chat"],
        health: "up",
      },
      {
        id: "huge",
        provider: "stub",
        max_context_tokens: 200_000,
        input_usd_per_mtok: 5,
        output_usd_per_mtok: 5,
        capabilities: ["chat"],
        health: "up",
      },
    ];
    const econ = computeRouteEconomics({
      original_tokens: 50_000,
      retained_tokens: 4_000,
      catalog,
      policy: {
        routing: { strategy: "cheapest_fit", output_tokens_reserve: 500 },
      },
    });
    assert.equal(econ.without_compress.model, "huge");
    assert.equal(econ.with_compress.model, "tiny");
    assert.equal(econ.model_changed, true);
    assert.ok(econ.dollars_saved_est > 0);
  });

  it("attachEconomicsToTrace stacks token + route dollars", () => {
    const trace = buildCompressionTrace({
      original_tokens: 10_000,
      retained_tokens: 2_000,
      strategy: "local_keep",
    });
    const econ = {
      dollars_saved_est: 0.05,
      model_changed: true,
    };
    const enriched = attachEconomicsToTrace(trace, econ, { usdPerMTok: 1 });
    assert.ok(enriched.dollars_avoided_est >= 0.05);
    assert.equal(enriched.meta.economics.model_changed, true);
    assert.ok(enriched.meta.dollars_avoided_tokens_est > 0);
  });
});
