const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const engine = require("./engine");

const previous = process.env.SC_COMPRESS_ENGINE;
afterEach(() => {
  if (previous === undefined) delete process.env.SC_COMPRESS_ENGINE;
  else process.env.SC_COMPRESS_ENGINE = previous;
});

function agentDump() {
  return [
    "# Cursor tool: Shell",
    "cd /Users/me/app && npm install",
    ...Array.from({ length: 120 }, (_, i) => `npm WARN deprecated left-pad@${i}.0.0: use something else`),
    "# Cursor tool: Read",
    "path: src/auth/session.ts",
    "export async function createSession(userId: string) {",
    "  const started = Date.now();",
    "  const AUTH_TIMEOUT_MS = 45000;",
    '  if (Date.now() - started > AUTH_TIMEOUT_MS) throw new Error("timeout");',
    "  return { userId, expiresIn: AUTH_TIMEOUT_MS };",
    "}",
    "# Cursor tool: Read package-lock.json",
    ...Array.from({ length: 150 }, (_, i) => `    "node_modules/dep-${i}": { "version": "1.0.${i}" },`),
  ].join("\n");
}

test("the Fast engine is the default and keeps the answer", async () => {
  delete process.env.SC_COMPRESS_ENGINE;
  assert.equal(engine.fastEngineEnabled(), true);
  const context = agentDump();
  const result = await engine.compressAdaptive(context, "What is AUTH_TIMEOUT_MS in createSession?");
  assert.equal(result.mode, "fast");
  assert.equal(result.policy_name, "SuperCompress Fast Extractive");
  assert.equal(result.compression_safety.status, "accepted");
  assert.ok(result.compressed_text.includes("AUTH_TIMEOUT_MS = 45000"));
  assert.ok(result.tokens_saved_pct >= 50, `saved ${result.tokens_saved_pct}%`);
  assert.ok(result.kept_tokens < result.original_tokens);
  assert.equal(result.neural_keep_fallback, false);
});

test("the Fast engine leaves inputs under about 1k tokens alone", async () => {
  delete process.env.SC_COMPRESS_ENGINE;
  const small = Array.from({ length: 20 }, (_, i) => `line ${i}: value ${i * 7}`).join("\n");
  const result = await engine.compressAdaptive(small, "What is the value on line 3?");
  assert.equal(result.compressed_text, small);
  assert.equal(result.compression_safety.status, "passthrough");
  assert.equal(result.tokens_saved, 0);
});

test("SC_COMPRESS_ENGINE=legacy turns the Fast engine off", () => {
  for (const value of ["legacy", "neural", "NEURAL-KEEP", " compiler "]) {
    process.env.SC_COMPRESS_ENGINE = value;
    assert.equal(engine.fastEngineEnabled(), false, value);
  }
  process.env.SC_COMPRESS_ENGINE = "fast";
  assert.equal(engine.fastEngineEnabled(), true);
});

test("a 120k-character input compresses well inside the request budget", async () => {
  delete process.env.SC_COMPRESS_ENGINE;
  const big = Array.from({ length: 2400 }, (_, i) => `row ${i}: status=ok latency_ms=${(i * 37) % 900} region=us-${i % 5}`).join("\n").slice(0, 120_000);
  const started = Date.now();
  const result = await engine.compressAdaptive(big + "\nrow 9999: status=FAILED region=eu-1", "Which row failed?");
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);
  assert.ok(result.compressed_text.includes("status=FAILED"));
});
