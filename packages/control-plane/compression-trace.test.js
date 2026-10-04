"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCompressionTrace,
  estimateDollarsAvoided,
  traceFromCompressResult,
} = require("./compression-trace");

describe("compression trace", () => {
  it("builds ratio and requires skip_reason on skip", () => {
    const t = buildCompressionTrace({
      original_tokens: 100,
      retained_tokens: 40,
      strategy: "neural_keep",
    });
    assert.equal(t.ratio, 0.4);
    assert.equal(t.strategy, "neural_keep");
    assert.deepEqual(t.model_eligibility, []);

    const skip = buildCompressionTrace({
      original_tokens: 10,
      retained_tokens: 10,
      strategy: "skip",
    });
    assert.equal(skip.skip_reason, "unspecified");
  });

  it("estimates dollars avoided", () => {
    assert.equal(estimateDollarsAvoided(1_000_000, 400_000, 0.1), 0.06);
  });

  it("from compress result", () => {
    const t = traceFromCompressResult({
      original_tokens: 200,
      kept_tokens: 80,
      engine: "neural_keep",
      confidence: 0.9,
    });
    assert.equal(t.strategy, "neural_keep");
    assert.equal(t.retained_tokens, 80);
    assert.equal(t.confidence, 0.9);
    assert.ok(t.dollars_avoided_est > 0);
  });
});
