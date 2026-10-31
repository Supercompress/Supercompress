const assert = require("node:assert/strict");
const { test, after } = require("node:test");
const { installNeuralKeepMock } = require("./test-neural-mock");

const originalFetch = global.fetch;
const originalEnv = { ...process.env };
process.env.SC_NEURAL_KEEP_MIN_TOKENS = "0";
let candidate;
installNeuralKeepMock(() => candidate);
const engine = require("./engine");
const context = Array(11376).fill("evidence").join(" ");
const header = "# SuperCompress context digest\n" + Array(16).fill("heading").join(" ");

after(() => {
  global.fetch = originalFetch;
  process.env = originalEnv;
});

function mockResult(text) {
  candidate = {
    compressed_text: text,
    original_tokens: 11376,
    kept_tokens: 20,
    tokens_saved_pct: 99.8,
  };
}

for (const [name, text] of [
  ["header-only 11376-to-20 collapse", header],
  ["bloating", context + " extra words"],
  ["three-percent savings", Array(11035).fill("evidence").join(" ")],
]) {
  test(`passes through ${name} with an explicit warning`, async () => {
    mockResult(text);
    const result = await engine.compressAdaptive(context, "Preserve the evidence.");
    assert.equal(result.compressed_text, context);
    assert.equal(result.mode, "passthrough");
    assert.equal(result.original_tokens, 11376);
    assert.equal(result.kept_tokens, 11376);
    assert.equal(result.compressed_tokens, 11376);
    assert.equal(result.tokens_saved, 0);
    assert.equal(result.tokens_saved_pct, 0);
    assert.ok(result.warnings.length > 0);
    assert.equal(result.compression_safety.semantic_verification, "not_performed");
  });
}

test("preserves useful compression and recounts untrusted remote metrics", async () => {
  const text = Array(2000).fill("evidence").join(" ");
  mockResult(text);
  const result = await engine.compressAdaptive(context, "Preserve the evidence.");
  assert.equal(result.compressed_text, text);
  assert.equal(result.mode, "neural-keep");
  assert.equal(result.kept_tokens, 2000);
  assert.equal(result.tokens_saved, 9376);
  assert.equal(result.tokens_saved_pct, (9376 / 11376) * 100);
});

test("preserves substantial output even with over 99% savings", async () => {
  const text = Array(92).fill("evidence").join(" ");
  mockResult(text);
  const result = await engine.compressAdaptive(context, "Preserve the evidence.");
  assert.equal(result.compressed_text, text);
  assert.equal(result.kept_tokens, 92);
});

test("guards local adaptive, fixed and CCR engine entry points", async () => {
  process.env.SC_NEURAL_KEEP = "0";
  const local = engine.getEngine();
  for (const [method, call] of [
    ["compressAdaptive", () => engine.compressAdaptive(context, "q")],
    ["compressContext", () => engine.compress(context, "q")],
    ["compressCCR", () => engine.compressCCR(context, "q")],
  ]) {
    const original = local[method];
    local[method] = () => ({ compressed_text: header, answer_quality: 100, verifier: { risk: "low" } });
    try {
      const result = await call();
      assert.equal(result.compressed_text, context);
      assert.equal(result.answer_quality, null);
      assert.equal(result.verifier, null);
    } finally {
      local[method] = original;
    }
  }
  delete process.env.SC_NEURAL_KEEP;
});
