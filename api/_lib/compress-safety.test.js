const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { isGenericQuery, assessResult, quotaStatus, DUMP_KEEP_RATIO } = require("./compress-safety");
const { compress, compressAdaptive } = require("./engine");
const { mcpCompressPayload } = require("./mcp-http");

test("queryless and filler asks are generic; asks that name a target are not", () => {
  for (const q of [
    undefined,
    "",
    "Summarize this context.",
    "please summarize the page",
    "tl;dr",
    "Compress this context for the coding task.",
    "Compress this context for the coding task. (part 2/3)",
    "Compact this session memory.",
    "Coding-agent context dump. Keep stack traces, errors, file contents, return values, and task symbols.",
  ]) {
    assert.equal(isGenericQuery(q), true, String(q));
  }
  for (const q of [
    "What does transform9 return?",
    "Summarize the auth failures in this log?",
    "summarize what changed in rfc 9562 timestamps",
    "why did the build fail",
  ]) {
    assert.equal(isGenericQuery(q), false, q);
  }
});

test("results that cannot beat the input are passthroughs", () => {
  assert.deepEqual(assessResult({ originalTokens: 30, keptTokens: 30 }).passthrough, true);
  assert.equal(assessResult({ originalTokens: 100, keptTokens: 210 }).reason, "output_larger_than_input");
  assert.equal(assessResult({ originalTokens: 1000, keptTokens: 970 }).passthrough, true);
  assert.equal(assessResult({ originalTokens: 0, keptTokens: 0 }).passthrough, true);
  assert.deepEqual(assessResult({ originalTokens: 1000, keptTokens: 900 }), { passthrough: false });
});

test("a near-empty digest of a large input carries a warning with the numbers", () => {
  const verdict = assessResult({ originalTokens: 11376, keptTokens: 20 });
  assert.equal(verdict.passthrough, false);
  assert.match(verdict.warning, /kept 20 of 11,376 tokens/);
  assert.equal(assessResult({ originalTokens: 11376, keptTokens: 20, dumpMode: true }).warning, undefined);
  assert.equal(assessResult({ originalTokens: 11376, keptTokens: 900 }).warning, undefined);
});

test("quota status warns near and at zero, never for comped accounts", () => {
  const empty = quotaStatus({ tokensUsed: 8_886_094, allowance: 5_000_000 });
  assert.equal(empty.free_tokens_remaining, 0);
  assert.match(empty.warning, /Free monthly quota used: 8,886,094 of 5,000,000/);
  assert.match(quotaStatus({ tokensUsed: 4_600_000, allowance: 5_000_000 }).warning, /400,000 of 5,000,000/);
  assert.equal(quotaStatus({ tokensUsed: 1_000_000, allowance: 5_000_000 }).warning, undefined);
  const comped = quotaStatus({ tokensUsed: 8_886_094, allowance: 5_000_000, comped: true });
  assert.equal(comped.billing, "comped");
  assert.equal(comped.warning, undefined);
});

test("dump mode keeps about half of a research page the queryless path reduced to a header", async () => {
  const page = fs.readFileSync(path.join(__dirname, "..", "..", "tests", "fixtures", "rfc9562-excerpt.txt"), "utf8");
  const anchored = await compressAdaptive(page, "Summarize this context.");
  const dump = compress(page, "Summarize this context.", DUMP_KEEP_RATIO);
  assert.ok(dump.kept_tokens >= dump.original_tokens * 0.4, `dump kept ${dump.kept_tokens}/${dump.original_tokens}`);
  assert.ok(dump.kept_tokens > anchored.kept_tokens * 10);
});

test("hosted MCP returns one copy of the digest and does not echo passthroughs", () => {
  const digest = mcpCompressPayload({
    compressed_text: "kept line",
    original_tokens: 1000,
    kept_tokens: 20,
    tokens_saved_pct: 98,
    compression_warning: "Deep cut",
    quota_warning: "Free monthly quota used",
    query_mode: "query",
  }, "s1");
  assert.equal(JSON.stringify(digest).split("kept line").length - 1, 1);
  assert.equal(Object.keys(digest)[0], "warning");
  assert.equal(digest.quota_warning, "Free monthly quota used");
  const pass = mcpCompressPayload({ passthrough: true, compressed_text: "x".repeat(400), original_tokens: 100 }, "s1");
  assert.equal(pass.passthrough, true);
  assert.equal(JSON.stringify(pass).includes("x".repeat(50)), false);
});
