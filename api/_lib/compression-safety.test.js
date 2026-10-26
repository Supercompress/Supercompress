const assert = require("node:assert/strict");
const { test } = require("node:test");
const { countTokens, enforceCompressionSafety } = require("./compression-safety");

test("uses consistent lexical estimates for code, Unicode, whitespace and empty strings", () => {
  assert.equal(countTokens("const value = 12;\n中文"), 8);
  assert.equal(countTokens(""), 0);
  assert.equal(countTokens("  \n"), 2);
});

test("accepts exactly 5% savings but rejects anything smaller", () => {
  const context = Array(100).fill("word").join(" ");
  assert.equal(enforceCompressionSafety(context, { compressed_text: Array(95).fill("word").join(" ") }).compression_safety.status, "accepted");
  assert.equal(enforceCompressionSafety(context, { compressed_text: Array(96).fill("word").join(" ") }).mode, "passthrough");
});

test("rejects malformed and empty output without trusting reported counts", () => {
  for (const candidate of [null, {}, { compressed_text: null }, { compressed_text: {} }, { compressed_text: " \n" }]) {
    const result = enforceCompressionSafety("Original evidence.", candidate);
    assert.equal(result.compressed_text, "Original evidence.");
    assert.equal(result.fallback_reason, "invalid_compression_output");
    assert.equal(result.tokens_saved, 0);
  }
});

test("does not accept text expansion hidden by lexical token estimates", () => {
  const context = Array(100).fill("word").join(" ");
  const result = enforceCompressionSafety(context, { compressed_text: "longword".repeat(200) });
  assert.equal(result.compressed_text, context);
  assert.equal(result.mode, "passthrough");
  assert.equal(result.tokens_saved, 0);
});

test("bounds collapse detection without rejecting every high-ratio or small-input result", () => {
  const words = (count) => Array(count).fill("word").join(" ");
  for (const [input, output, status] of [
    [1000, 9, "passthrough"],
    [1000, 10, "accepted"],
    [999, 9, "accepted"],
    [11376, 64, "passthrough"],
    [11376, 65, "accepted"],
  ]) {
    const result = enforceCompressionSafety(words(input), { compressed_text: words(output) });
    assert.equal(result.compression_safety.status, status);
  }
});

test("rechecking passthrough preserves its reason without duplicate warnings", () => {
  const context = Array(11376).fill("word").join(" ");
  const first = enforceCompressionSafety(context, { compressed_text: "# Digest", ccr: { hash: "stale" } });
  const second = enforceCompressionSafety(context, first);
  assert.deepEqual(second, first);
  assert.equal(second.ccr, null);
});
