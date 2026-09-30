/**
 * Coding-agent compression quality — real Cursor-like dumps.
 * Run: node api/_lib/compress-quality.test.js
 */
const assert = require("assert");
const { installNeuralKeepMock, lineKeepFilter } = require("./test-neural-mock");

installNeuralKeepMock((context, query) =>
  lineKeepFilter(context, query, (line) => {
    if (/AUTH_TIMEOUT_MS|createSession|session\.ts|# Cursor tool:/i.test(line)) return true;
    if (/npm WARN deprecated|node_modules\/dep-|legacy\/file_/.test(line)) return false;
    return /export async function|const started/.test(line);
  })
);

const { compressAdaptive } = require("./engine");

function cursorishDump() {
  const needle = 'const AUTH_TIMEOUT_MS = 45000;';
  return [
    "# Cursor tool: Shell",
    "cd /Users/me/app && npm install",
    ...Array.from({ length: 120 }, (_, i) => `npm WARN deprecated left-pad@${i}.0.0: use something else`),
    ...Array.from({ length: 40 }, (_, i) => `added ${i} packages in ${i}ms`),
    "# Cursor tool: Read",
    "path: src/auth/session.ts",
    "export async function createSession(userId: string) {",
    "  const started = Date.now();",
    `  ${needle}`,
    '  if (Date.now() - started > AUTH_TIMEOUT_MS) throw new Error("timeout");',
    "  return { userId, expiresIn: AUTH_TIMEOUT_MS };",
    "}",
    "# Cursor tool: Grep",
    ...Array.from({ length: 80 }, (_, i) => `src/legacy/file_${i}.ts:${i}: // old comment about sessions`),
    "# Cursor tool: Read package-lock.json",
    ...Array.from({ length: 150 }, (_, i) => `    "node_modules/dep-${i}": {`),
    ...Array.from({ length: 150 }, (_, i) => `      "version": "1.0.${i}",`),
    ...Array.from({ length: 150 }, (_, i) => `      "resolved": "https://registry.npmjs.org/dep-${i}/-/${i}.tgz",`),
  ].join("\n");
}

(async () => {
  const ctx = cursorishDump();
  const genericQ =
    "Compress new Shell output for the current coding task. Preserve code, paths, errors, numbers, and decisions.";
  const r = await compressAdaptive(ctx, genericQ);

  assert.ok(r.compressed_text.trim().length > 0, "must not wipe context");
  assert.ok(r.compressed_text.includes("AUTH_TIMEOUT_MS = 45000"), "must keep answer needle");
  assert.ok(r.compressed_text.includes("createSession"), "must keep function");
  assert.ok(r.tokens_saved_pct >= 85, `expect strong cut on noisy agent dump, got ${r.tokens_saved_pct}`);
  const npmWarns = (r.compressed_text.match(/npm WARN deprecated/g) || []).length;
  assert.ok(npmWarns <= 4, `npm WARN should be crushed, got ${npmWarns}`);
  const lockHits = (r.compressed_text.match(/node_modules\/dep-/g) || []).length;
  assert.ok(lockHits <= 4, `lockfile noise should be crushed, got ${lockHits}`);
  assert.ok(
    /Focus symbols and paths:|AUTH_TIMEOUT_MS|createSession|session\.ts/i.test(
      // policy path stores enriched query only internally; assert via kept content
      r.compressed_text
    ),
    "focus content retained"
  );

  console.log("compress-quality.test.js: ok", {
    pct: +r.tokens_saved_pct.toFixed(2),
    in: r.original_tokens,
    out: r.kept_tokens,
    npmWarns,
    lockHits,
    preprocessor: r.preprocessor,
    policy: r.policy_name,
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
