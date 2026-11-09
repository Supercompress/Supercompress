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
  test(`rejects Neural Keep ${name} and falls back to the compiler`, async () => {
    mockResult(text);
    const result = await engine.compressAdaptive(context, "Preserve the evidence.");
    assert.notEqual(result.compressed_text, text);
    assert.notEqual(result.mode, "neural-keep");
    assert.equal(result.original_tokens, 11376);
    if (result.mode === "passthrough") {
      assert.equal(result.compressed_text, context);
      assert.equal(result.tokens_saved, 0);
      assert.ok(result.warnings.length > 0);
    } else {
      assert.equal(result.neural_keep_fallback, true);
      assert.equal(result.fallback_reason, "neural_keep_insufficient_savings");
      assert.equal(result.compression_safety.status, "accepted");
      assert.ok(result.tokens_saved_pct >= 5);
    }
    assert.equal(result.compression_safety.semantic_verification, "not_performed");
  });
}

test("small agent tool output: Neural Keep keeps every line, compiler result is returned", async () => {
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push(`api/_lib/store.js:${100 + i}:  if (skipFirestore()) return memoryStore.get(key${i}); // fallback path ${i}`);
  const small = lines.join("\n");
  mockResult(small); // keep-all: 0% savings -> previously passthrough
  const result = await engine.compressAdaptive(small, "Which line handles key7?");
  assert.equal(result.compression_safety.status, "accepted");
  assert.equal(result.mode, "compiler");
  assert.equal(result.fallback_reason, "neural_keep_insufficient_savings");
  assert.ok(result.tokens_saved_pct >= 5, `saved ${result.tokens_saved_pct}`);
  assert.ok(result.compressed_text.includes("key7"), "query evidence kept");
});

test("returns Neural Keep passthrough when the compiler cannot help either", async () => {
  const tiny = "ok";
  mockResult(tiny);
  const result = await engine.compressAdaptive(tiny, "status?");
  assert.equal(result.compressed_text, tiny);
  assert.equal(result.mode, "passthrough");
});

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
