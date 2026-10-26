const assert = require("node:assert/strict");
const { test, after } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-mcp-safety-"));
const previousConfig = process.env.SUPERCOMPRESS_CONFIG_DIR;
const previousKey = process.env.SUPERCOMPRESS_API_KEY;
process.env.SUPERCOMPRESS_CONFIG_DIR = configDir;
process.env.SUPERCOMPRESS_API_KEY = "sc_mock";
const hooks = require("../src/cursor-hooks/compress-prompt-lib");
after(() => {
  if (previousConfig === undefined) delete process.env.SUPERCOMPRESS_CONFIG_DIR;
  else process.env.SUPERCOMPRESS_CONFIG_DIR = previousConfig;
  if (previousKey === undefined) delete process.env.SUPERCOMPRESS_API_KEY;
  else process.env.SUPERCOMPRESS_API_KEY = previousKey;
  fs.rmSync(configDir, { recursive: true, force: true });
});

async function withApi(body, run, status = 200) {
  const previousFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    return { ok: status === 200, status, json: async () => typeof body === "function" ? body(request) : body };
  };
  try { await run(requests); } finally { global.fetch = previousFetch; }
}

function loadMcp(result) {
  const filename = path.join(__dirname, "../src/mcp.js");
  const localRequire = createRequire(filename);
  const sandbox = {
    require(name) {
      if (name === "./cursor-hooks/compress-prompt-lib") return {
        compressIncremental: async () => result,
        shouldPublishCompressedResult: hooks.shouldPublishCompressedResult,
        writeInbox() {},
      };
      return localRequire(name);
    },
    process: { env: process.env, version: process.version, on() {}, stdin: { on() {}, resume() {} }, stdout: { on() {}, write() {} } },
    console: { error() {} }, Buffer, setTimeout, clearTimeout,
  };
  vm.runInNewContext(`${fs.readFileSync(filename, "utf8")}\nthis.testApi = { handleToolCall, TOOLS };`, sandbox);
  return sandbox.testApi;
}

test("installed MCP schema permits raw dumps and surfaces real safety and quota fields", async () => {
  const safety = { status: "passthrough", reason: "insufficient_savings" };
  const { handleToolCall, TOOLS } = loadMcp({ compressed: "raw text", original_tokens: 2, compressed_tokens: 2, savings_pct: 0, warnings: ["Kept original"], compression_safety: safety, free_tokens_remaining: 0, credit_wallet: true, credit_balance_usd: 3 });
  assert.deepEqual(Array.from(TOOLS.find(tool => tool.name === "compress_context").inputSchema.required), ["context"]);
  const result = await handleToolCall("compress_context", { context: "raw text" });
  const output = JSON.parse(result.content[0].text);
  assert.equal(output.compressed_text, "raw text");
  assert.deepEqual(output.compression_safety, safety);
  assert.match(output.warnings.join(" "), /Kept original/);
  assert.match(output.warnings.join(" "), /exhausted.*prepaid.*3/i);
});

test("raw bypass stays exact, retryable and out of rolling memory", async () => {
  const context = `  ${"raw diagnostic evidence ".repeat(20)}\n`;
  await withApi(request => ({ compressed_text: request.context, original_tokens: 120, kept_tokens: 120, warnings: ["Kept original"], compression_safety: { status: "passthrough", reason: "insufficient_savings" } }), async requests => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await hooks.compressIncremental({ context, sessionId: "bypass", kind: "mcp" });
      assert.equal(result.compressed, context);
      assert.equal(result.compacted, false);
      assert.equal(result.compression_safety.status, "passthrough");
      assert.deepEqual(result.warnings, ["Kept original"]);
    }
    assert.equal(requests.length, 2);
    assert.equal(requests[0].query, "");
    assert.equal(fs.existsSync(path.join(configDir, "sessions/bypass/state.json")), false);
  });
});

test("HTTP paywall retains real reason and safety warnings", async () => {
  await withApi({ detail: "Insufficient prepaid balance", code: "credits_exhausted", credit_balance_usd: 0.01, warnings: ["Request not delivered"] }, async () => {
    const result = await hooks.compressIncremental({ context: "billing diagnostic ".repeat(15), sessionId: "paywall", kind: "mcp" });
    assert.equal(result.paywall, true);
    assert.equal(result.code, "credits_exhausted");
    const reply = await loadMcp(result).handleToolCall("compress_context", { context: "dump" });
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /Insufficient prepaid balance/);
    assert.match(reply.content[0].text, /Request not delivered/);
    assert.match(reply.content[0].text, /billing/);
    assert.equal(fs.existsSync(path.join(configDir, "sessions/paywall/state.json")), false);
  }, 402);
});

test("accepted deltas keep warnings, quota and explicit query through rolling memory", async () => {
  const query = "  Investigate payment failures  ";
  await withApi({ compressed_text: "Payment failed: timeout in payment.ts", original_tokens: 100, kept_tokens: 10, warnings: ["Heuristic only"], compression_safety: { status: "accepted", semantic_verification: "not_performed" }, free_tokens_remaining: 12 }, async requests => {
    const result = await hooks.compressIncremental({ context: "payment diagnostics ".repeat(20), query, sessionId: "accepted", kind: "mcp" });
    assert.equal(requests[0].query, query.trim());
    assert.equal(result.compression_safety.status, "accepted");
    assert.ok(result.warnings.includes("Heuristic only"));
    assert.match(result.warnings.join(" "), /12 free tokens remaining/);
    assert.equal(result.free_tokens_remaining, 12);
    assert.match(fs.readFileSync(path.join(configDir, "sessions/accepted/memory.md"), "utf8"), /Payment failed/);
  });
});

test("partial errors preserve warnings without publishing failed chunks", async () => {
  const result = { compressed: "partial digest", partial: true, warnings: ["Evidence unavailable"], skipped: "partial_chunk_failure" };
  const reply = await loadMcp(result).handleToolCall("compress_context", { context: "dump" });
  assert.equal(reply.isError, true);
  assert.match(reply.content[0].text, /partially failed/);
  assert.match(reply.content[0].text, /Evidence unavailable/);
  assert.doesNotMatch(reply.content[0].text, /partial digest/);
});

test("automatic compaction reports the latest quota snapshot without stale quota notices", async () => {
  let calls = 0;
  await withApi(() => {
    calls++;
    return calls === 1
      ? { compressed_text: "Retained evidence. ".repeat(1500), original_tokens: 15000, kept_tokens: 8000, free_tokens_remaining: 10, tokens_used_this_period: 90, warnings: ["Heuristic only"] }
      : { compressed_text: "Compacted evidence", original_tokens: 8000, kept_tokens: 10, free_tokens_remaining: 0, tokens_used_this_period: 100 };
  }, async () => {
    const result = await hooks.compressIncremental({ context: "New diagnostics. ".repeat(3000), sessionId: "automatic-quota", kind: "mcp" });
    assert.equal(calls, 2);
    assert.equal(result.compacted, true);
    assert.equal(result.free_tokens_remaining, 0);
    assert.equal(result.tokens_used_this_period, 100);
    assert.ok(result.warnings.includes("Heuristic only"));
    assert.match(result.warnings.join(" "), /exhausted/);
    assert.doesNotMatch(result.warnings.join(" "), /10 free tokens remaining/);
  });
});

test("bypassed or growing compaction never rewrites memory", async () => {
  const memory = "Retain all previous evidence. ".repeat(40);
  for (const fields of [{ compression_safety: { status: "passthrough", reason: "insufficient_savings" } }, {}]) {
    const state = { memory, seen: {}, seen_order: [] };
    await withApi({ compressed_text: `${memory} more text`, ...fields }, async () => {
      const result = await hooks.compactSessionMemory("compact", "task", { state, persistInbox: false });
      assert.equal(result.compacted, false);
      assert.equal(result.compressed, memory.trim());
      assert.equal(state.memory, memory);
      assert.equal(fs.existsSync(path.join(configDir, "sessions/compact/state.json")), false);
    });
  }
});

test("chunked raw dumps keep query empty and preserve bypass warnings", async () => {
  await withApi(request => ({ compressed_text: request.context, warnings: ["Kept original"], compression_safety: { status: "passthrough", reason: "insufficient_savings" } }), async requests => {
    const context = "x".repeat(hooks.API_MAX_CHARS + 100);
    const result = await hooks.compressContext(context, "", "test");
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.query === ""));
    assert.equal(result.compressed, context);
    assert.equal(result.savings_pct, 0);
    assert.ok(result.warnings.includes("Kept original"));
  });
});

test("oversized dumps are not silently truncated", async () => {
  const context = "x".repeat(1_200_001);
  await withApi({}, async requests => {
    const result = await hooks.compressContext(context, "", "test");
    assert.equal(result.compressed, context);
    assert.equal(result.skip_reason, "context_limit");
    assert.equal(requests.length, 0);
  });
});

test("raw whitespace counts toward the hook context limit", async () => {
  const context = " ".repeat(1_200_000) + "evidence ".repeat(10);
  await withApi({}, async requests => {
    const result = await hooks.compressContext(context, "", "test");
    assert.equal(result.compressed, context);
    assert.equal(result.skip_reason, "context_limit");
    assert.equal(requests.length, 0);
  });
});

test("chunked compression retains safety warnings but only the latest quota notice", async () => {
  let calls = 0;
  await withApi(() => ({ compressed_text: "Retained evidence", free_tokens_remaining: ++calls === 1 ? 10 : 0, warnings: ["Heuristic only"] }), async () => {
    const result = await hooks.compressContext("evidence ".repeat(15000), "", "test");
    assert.equal(calls, 2);
    assert.equal(result.free_tokens_remaining, 0);
    assert.ok(result.warnings.includes("Heuristic only"));
    assert.match(result.warnings.join(" "), /exhausted/);
    assert.doesNotMatch(result.warnings.join(" "), /10 free tokens remaining/);
  });
});

test("compaction accounts for its persisted header before replacing memory", async () => {
  const memory = "evidence ".repeat(12).trim();
  const state = { memory, seen: {}, seen_order: [] };
  await withApi({ compressed_text: memory.slice(0, -10) }, async () => {
    const result = await hooks.compactSessionMemory("header-growth", "task", { state, persistInbox: false });
    assert.equal(result.compacted, false);
    assert.equal(state.memory, memory);
    assert.equal(result.skip_reason, "compaction_no_savings");
  });
});
