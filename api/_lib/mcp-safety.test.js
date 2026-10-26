const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { TOOLS, handleToolCall } = require("./mcp-http");

function loadLocal(result) {
  const handlers = new Map();
  const calls = [];
  const sandbox = {
    require(name) {
      if (name === "@modelcontextprotocol/sdk/server/index.js") {
        return { Server: class {
          setRequestHandler(schema, handler) { handlers.set(schema, handler); }
          async connect() {}
        } };
      }
      if (name === "@modelcontextprotocol/sdk/server/stdio.js") {
        return { StdioServerTransport: class {} };
      }
      if (name === "@modelcontextprotocol/sdk/types.js") {
        return { ListToolsRequestSchema: "list", CallToolRequestSchema: "call" };
      }
      if (name === "../api/_lib/engine") {
        const compress = async (...args) => { calls.push(args); return result; };
        return { compressAdaptive: compress, compressCCR: compress };
      }
      if (name === "../api/_lib/mcp-response") return require("./mcp-response");
      return require(name);
    },
    console: { error() {} },
    process,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../mcp/server.js"), "utf8"), sandbox);
  return { handlers, calls };
}

async function hosted(body, args = { context: "raw log dump" }, status = 200) {
  const previousFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, body: options.body && JSON.parse(options.body) });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  try {
    return { result: await handleToolCall("compress_context", args, "sc_test"), requests };
  } finally {
    global.fetch = previousFetch;
  }
}

test("hosted accepts omitted and blank queries as raw dumps", async () => {
  assert.deepEqual(TOOLS.find(tool => tool.name === "compress_context").inputSchema.required, ["context"]);
  for (const query of [undefined, "", "   "]) {
    const { result, requests } = await hosted({ compressed_text: "digest" }, { context: "raw log dump", query });
    assert.notEqual(result.isError, true);
    assert.equal(requests[0].body.query, undefined);
  }
});

test("hosted preserves API warnings and bypass status outside digest", async () => {
  const warnings = ["Unsafe compression bypassed", { code: "quality_guard", detail: "Kept original" }];
  const safety = { status: "passthrough", reason: "insufficient_savings", semantic_verification: "not_performed" };
  const { result } = await hosted({ compressed_text: "raw log dump", warnings, skip_reason: "quality_guard", compression_safety: safety, mode: "passthrough", original_tokens: 4, kept_tokens: 4 });
  const output = JSON.parse(result.content[0].text);
  assert.equal(output.passthrough, true);
  assert.equal(result.content[0].text.includes("raw log dump"), false);
  assert.deepEqual(output.warnings, warnings);
  assert.equal(output.skip_reason, "quality_guard");
  assert.equal(output.mode, "passthrough");
  assert.deepEqual(output.compression_safety, safety);
  // A safety passthrough on the billed path must not claim it was free.
  assert.doesNotMatch(output.notice, /Not billed/);
});

test("hosted passes through per-request notices, query mode, and not-billed passthroughs", async () => {
  const dump = JSON.parse((await hosted({ compressed_text: "digest", original_tokens: 100, kept_tokens: 50, query_mode: "dump", mode: "dump", notice: "Dump mode kept about half." })).result.content[0].text);
  assert.equal(dump.mode, "dump");
  assert.equal(dump.notice, "Dump mode kept about half.");
  assert.equal(dump.compressed_context, "digest");
  const notice = "Returned the input unchanged: compression would have saved 2% (98 vs 100 tokens). Not billed.";
  const pass = JSON.parse((await hosted({ passthrough: true, billed: false, compressed_text: "raw log dump", query_mode: "query", notice })).result.content[0].text);
  assert.equal(pass.passthrough, true);
  assert.equal(pass.notice, notice);
  assert.equal(pass.compressed_context, undefined);
  const empty = await hosted({ original_tokens: 10, kept_tokens: 0 });
  assert.equal(empty.result.isError, true);
});

test("hosted distinguishes remaining free quota, exhaustion and prepaid billing", async () => {
  for (const [fields, expected] of [
    [{ free_tokens_remaining: 37 }, /37 free tokens remaining/i],
    [{ free_tokens_remaining: 0, limit_reached: true }, /free token allowance.*exhausted.*billing/i],
    [{ free_tokens_remaining: 0, credit_wallet: true, credit_balance_usd: 2 }, /free token allowance.*exhausted.*prepaid.*2/i],
    [{ credit_wallet: true, credit_balance_usd: 0 }, /prepaid.*0.*billing/i],
    [{ code: "credits_exhausted", credit_balance_usd: 0.01 }, /insufficient.*billing/i],
  ]) {
    const { result } = await hosted({ compressed_text: "digest", ...fields });
    assert.match(JSON.parse(result.content[0].text).warnings.join(" "), expected);
  }
  for (const fields of [{}, { free_tokens_remaining: null }, { free_tokens_remaining: "" }, { free_tokens_remaining: 0, unlimited: true }]) {
    const { result } = await hosted({ compressed_text: "digest", ...fields });
    assert.deepEqual(JSON.parse(result.content[0].text).warnings || [], []);
  }
});

test("hosted paywall preserves API detail plus explicit exhaustion and billing destination", async () => {
  const { result } = await hosted({ detail: "Request exceeds remaining allowance", code: "free_quota_exhausted", tokens_used: 8, free_tokens: 10, warnings: ["Original context retained"] }, undefined, 402);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Request exceeds remaining allowance/);
  assert.match(result.content[0].text, /Original context retained/);
  assert.match(result.content[0].text, /billing/);
});

test("local accepts raw dumps and preserves safety metadata", async () => {
  const { handlers, calls } = loadLocal({ compressed_text: "raw log dump", original_tokens: 4, kept_tokens: 4, tokens_saved_pct: 0, warnings: ["Kept original"], skip_reason: "quality_guard", compression_safety: { status: "passthrough", reason: "insufficient_savings" } });
  const tools = (await handlers.get("list")()).tools;
  assert.deepEqual(Array.from(tools.find(tool => tool.name === "compress").inputSchema.required), ["context"]);
  for (const mode of ["compiler", "ccr"]) {
    const result = await handlers.get("call")({ params: { name: "compress", arguments: { context: "raw log dump", query: "  ", mode } } });
    assert.equal(calls.at(-1)[1], "");
    assert.equal(result.content[0].text, "raw log dump");
    const stats = JSON.parse(result.content[1].text);
    assert.deepEqual(stats.warnings, ["Kept original"]);
    assert.equal(stats.skip_reason, "quality_guard");
    assert.equal(stats.compression_safety.status, "passthrough");
  }
});

test("standalone response helper copies match and require without the other deployment", () => {
  const root = path.join(__dirname, "../..");
  assert.equal(fs.readFileSync(path.join(root, "api/_lib/mcp-response.js"), "utf8"), fs.readFileSync(path.join(root, "packages/proxy/src/mcp-response.js"), "utf8"));
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "sc-mcp-packaged-"));
  try {
    for (const filename of ["api/_lib/mcp-http.js", "api/_lib/mcp-response.js", "packages/proxy/src/mcp.js", "packages/proxy/src/mcp-response.js", "packages/proxy/src/cursor-hooks/compress-prompt-lib.js", "packages/proxy/package.json"]) {
      const target = path.join(isolated, filename);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, filename), target);
    }
    for (const [cwd, script] of [
      [path.join(isolated, "api/_lib"), 'require("./mcp-http")'],
      [path.join(isolated, "packages/proxy"), 'require("./src/mcp-response"); require("./src/cursor-hooks/compress-prompt-lib")'],
    ]) {
      const result = spawnSync(process.execPath, ["-e", script], { cwd, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    const result = spawnSync(process.execPath, ["src/mcp.js"], {
      cwd: path.join(isolated, "packages/proxy"),
      input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
      encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    const tools = JSON.parse(result.stdout.trim()).result.tools;
    assert.deepEqual(tools.find(tool => tool.name === "compress_context").inputSchema.required, ["context"]);
  } finally {
    fs.rmSync(isolated, { recursive: true, force: true });
  }
});
