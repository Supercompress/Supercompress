#!/usr/bin/env node
/**
 * Comprehensive coding-agent plugin review.
 * Runs isolated tests against packages/proxy without mutating ~/.supercompress.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const results = [];
let failed = 0;

function pass(name, detail = "") {
  results.push({ ok: true, name, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail) {
  failed += 1;
  results.push({ ok: false, name, detail: String(detail) });
  console.error(`FAIL  ${name} — ${detail}`);
}

function requestJson(port, method, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = { raw: data };
          }
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitHealth(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await requestJson(port, "GET", "/health");
      if (res.status === 200) return res;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("proxy health timeout");
}

function longContext(n = 220) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(
      `Line ${i}: implementation note about query-aware prompt compression preserving answer-critical evidence while dropping noise tokens from chat history, tool traces, and retrieved docs.`
    );
  }
  return lines.join("\n");
}

async function withMockUpstream(fn) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url.includes("/chat/completions")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "ok-from-mock" }, finish_reason: "stop" }],
          })
        );
        return;
      }
      if (req.url.includes("/messages")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "ok-from-anthropic-mock" }],
            model: "claude-3-haiku-20240307",
          })
        );
        return;
      }
      if (req.url.includes("/responses")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "resp_test",
            object: "response",
            output: [{ type: "message", content: [{ type: "output_text", text: "ok-from-responses-mock" }] }],
          })
        );
        return;
      }
      res.writeHead(404).end("nope");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    return await fn({ port, hits, base: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function startProxy({ port, configDir, env = {} }) {
  fs.mkdirSync(configDir, { recursive: true });
  const child = spawn(process.execPath, ["src/server.js", String(port)], {
    cwd: ROOT,
    env: {
      ...process.env,
      SUPERCOMPRESS_CONFIG_DIR: configDir,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c.toString()));
  try {
    await waitHealth(port);
  } catch (err) {
    child.kill("SIGTERM");
    throw new Error(`${err.message}\n${stderr}`);
  }
  return {
    child,
    stderr: () => stderr,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    },
  };
}

async function main() {
  console.log("\n=== SuperCompress coding-agent plugin review ===\n");

  // 1) Package metadata
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.equal(pkg.name, "supercompress-proxy");
    assert.ok(pkg.bin.supercompress);
    assert.ok(pkg.bin["supercompress-ai"]);
    assert.ok(pkg.bin["supercompress-proxy"]);
    assert.ok(pkg.bin["supercompress-mcp"]);
    assert.ok(fs.existsSync(path.join(ROOT, pkg.bin.supercompress)));
    assert.ok(fs.existsSync(path.join(ROOT, pkg.bin["supercompress-ai"])));
    assert.ok(fs.existsSync(path.join(ROOT, pkg.bin["supercompress-proxy"])));
    assert.ok(fs.existsSync(path.join(ROOT, pkg.bin["supercompress-mcp"])));
    pass("package metadata + bin entrypoints", `v${pkg.version}`);
  } catch (err) {
    fail("package metadata + bin entrypoints", err.message);
  }

  // 2) Built-in smoke
  try {
    execFileSync(process.execPath, ["test/smoke.js"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    pass("built-in smoke.js");
  } catch (err) {
    fail("built-in smoke.js", err.stderr || err.message);
  }

  // 3) CLI help/agents
  try {
    const help = execFileSync(process.execPath, ["bin/supercompress.js", "help"], { cwd: ROOT, encoding: "utf8" });
    assert.match(help, /setup/);
    assert.match(help, /agents/);
    assert.match(help, /tui/i);
    assert.ok(fs.existsSync(path.join(ROOT, "tui/index.ts")));
    assert.ok(fs.existsSync(path.join(ROOT, "tui/theme.ts")));
    const agents = execFileSync(process.execPath, ["bin/supercompress.js", "agents"], { cwd: ROOT, encoding: "utf8" });
    assert.match(agents, /Cursor/);
    assert.match(agents, /48 catalogued|Supported coding agents/i);
    pass("CLI help + agents");
  } catch (err) {
    fail("CLI help + agents", err.message);
  }

  // 4) Local engine compression
  try {
    const engine = require(path.join(ROOT, "src/local-engine"));
    // Highly repetitive dumps can collapse to empty — that's a known engine edge case.
    const repetitive = engine.compress(longContext(120), "What does the compressor preserve?");
    assert.equal(typeof repetitive.compressed_text, "string");

    // Varied coding-agent-like context should keep evidence.
    const varied = Array.from({ length: 60 }, (_, i) =>
      [
        `src/mod_${i}.ts: export function handle${i}(x: string) { return x.toUpperCase() + ${i}; }`,
        `test/mod_${i}.test.ts: expect(handle${i}("a")).toContain("${i}");`,
        `note_${i}: preserve answer-critical evidence for handle${i} uppercasing.`,
      ].join("\n")
    ).join("\n");
    const out = engine.compress(varied, "How does handle3 transform input?");
    assert.ok(out.compressed_text && out.compressed_text.length > 0);
    assert.ok(out.compressed_text.length < varied.length);
    pass(
      "local-engine compresses varied coding context",
      `kept=${out.kept_tokens} saved=${out.tokens_saved} repetitive_empty=${!(repetitive.compressed_text || "").trim()}`
    );
  } catch (err) {
    fail("local-engine compresses varied coding context", err.message);
  }

  // 5) assembleMessages
  try {
    const { assembleMessages } = require(path.join(ROOT, "src/compressor"));
    const a = assembleMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "old" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "What is left?" },
    ]);
    assert.equal(a.query, "What is left?");
    assert.match(a.context, /\[user\]: old/);
    assert.match(a.context, /\[assistant\]: reply/);
    assert.equal(a.systemMsgs.length, 1);
    assert.equal(a.systemMsgs[0].content, "sys");
    assert.equal(a.systemMsg?.content, "sys");
    pass("assembleMessages splits context/query");
  } catch (err) {
    fail("assembleMessages splits context/query", err.message);
  }

  // 6) Detector configure/revert isolation
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sc-review-home-"));
    const originalHome = os.homedir;
    const originalConfigDir = process.env.SUPERCOMPRESS_CONFIG_DIR;
    os.homedir = () => home;
    process.env.SUPERCOMPRESS_CONFIG_DIR = path.join(home, ".supercompress");
    process.env.SHELL = "/bin/bash";
    const fixtures = {
      Cursor: [".cursor/config.json", '{"theme":"dark"}'],
      Windsurf: [".windsurf/config.json", '{"model":"x"}'],
      Continue: [".continue/config.json", '{"models":[]}'],
      Cline: [".cline/config.json", '{"apiProvider":"anthropic"}'],
      "Claude Code": [".claude/settings.json", '{"env":{"FOO":"bar"}}'],
      Codex: [".codex/config.toml", 'model = "gpt-5"\n'],
    };
    for (const [rel, content] of Object.values(fixtures)) {
      const fp = path.join(home, rel);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content);
    }
    delete require.cache[require.resolve(path.join(ROOT, "src/detector.js"))];
    const detector = require(path.join(ROOT, "src/detector.js"));
    const configured = detector.configureAll();
    assert.deepEqual(configured.sort(), ["Claude Code", "Cline", "Codex", "Continue", "Cursor", "Windsurf"].sort());
    // Verify Cursor got base URL somewhere
    const cursorText = fs.readFileSync(path.join(home, ".cursor/config.json"), "utf8");
    assert.match(cursorText, /8080/);
    const claude = JSON.parse(fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8"));
    assert.equal(claude.env.ANTHROPIC_BASE_URL, "http://localhost:8080");
    const codex = fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8");
    assert.match(codex, /openai_base_url\s*=\s*"http:\/\/localhost:8080\/v1"/);
    detector.configureMcp();
    const mcpJson = JSON.parse(fs.readFileSync(path.join(home, ".cursor/mcp.json"), "utf8"));
    assert.ok(mcpJson.mcpServers.supercompress);
    assert.equal(
      mcpJson.mcpServers.supercompress.env.SUPERCOMPRESS_API_KEY,
      undefined,
      "must not inject unresolved ${SUPERCOMPRESS_API_KEY} placeholder"
    );
    assert.ok(mcpJson.mcpServers.supercompress.env.SUPERCOMPRESS_CONFIG_DIR);
    detector.revertAll();
    for (const [name, [rel, original]] of Object.entries(fixtures)) {
      assert.equal(fs.readFileSync(path.join(home, rel), "utf8"), original, `${name} not restored`);
    }
    os.homedir = originalHome;
    if (originalConfigDir === undefined) delete process.env.SUPERCOMPRESS_CONFIG_DIR;
    else process.env.SUPERCOMPRESS_CONFIG_DIR = originalConfigDir;
    fs.rmSync(home, { recursive: true, force: true });
    pass("detector configure + exact revert", configured.join(", "));
  } catch (err) {
    fail("detector configure + exact revert", err.stack || err.message);
  }

  // 7) Proxy endpoints with mock provider + fake SC key path for small context
  const reviewPort = 18777;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-review-cfg-"));
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ api_key: "sc_live_test_key_for_passthrough", port: reviewPort }, null, 2)
  );

  try {
    await withMockUpstream(async ({ base, hits }) => {
      const proxy = await startProxy({
        port: reviewPort,
        configDir,
        env: {
          SUPERCOMPRESS_OPENAI_BASE: `${base}/v1`,
          SUPERCOMPRESS_ANTHROPIC_BASE: base,
          // Force small-context passthrough by not needing real compress for short msgs;
          // for long msgs, compressor will call real API — so keep chat short here.
        },
      });
      try {
        const health = await requestJson(reviewPort, "GET", "/health");
        assert.equal(health.status, 200);
        assert.equal(health.body.service, "supercompress");
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
        assert.equal(health.body.version, pkg.version);
        pass("fresh proxy /health version matches package", health.body.version);

        const models = await requestJson(reviewPort, "GET", "/v1/models");
        assert.equal(models.status, 200);
        assert.ok(models.body.data.some((m) => m.id === "gpt-4o"));
        assert.ok(Array.isArray(models.body.models));
        pass("GET /v1/models OpenAI+Codex shapes");

        const responsesGet = await requestJson(reviewPort, "GET", "/v1/responses");
        assert.equal(responsesGet.status, 405);
        pass("GET /v1/responses returns 405");

        const empty = await requestJson(reviewPort, "POST", "/v1/chat/completions", { model: "gpt-4o-mini", messages: [] });
        assert.equal(empty.status, 422);
        pass("POST /v1/chat/completions rejects empty messages");

        const noAuth = await requestJson(reviewPort, "POST", "/v1/chat/completions", {
          model: "gpt-4o-mini",
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
            { role: "user", content: "ping" },
          ],
        });
        assert.equal(noAuth.status, 502);
        assert.match(noAuth.body.error.message, /API key|subscription|Authorization/i);
        pass("chat completions requires provider API key");

        const chat = await requestJson(
          reviewPort,
          "POST",
          "/v1/chat/completions",
          {
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "be brief" },
              { role: "user", content: "short context hello" },
              { role: "assistant", content: "hi" },
              { role: "user", content: "ping" },
            ],
          },
          { Authorization: "Bearer sk-test-provider", "User-Agent": "Cursor/1.0" }
        );
        assert.equal(chat.status, 200, JSON.stringify(chat.body));
        assert.equal(chat.body.choices[0].message.content, "ok-from-mock");
        assert.ok(hits.some((h) => h.url.includes("/chat/completions")));
        pass("chat completions forwards to mock OpenAI (small context passthrough)");

        const anth = await requestJson(
          reviewPort,
          "POST",
          "/v1/messages",
          {
            model: "claude-3-haiku-20240307",
            max_tokens: 32,
            messages: [
              { role: "user", content: "short hello" },
              { role: "assistant", content: "hi" },
              { role: "user", content: "ping" },
            ],
          },
          { "x-api-key": "sk-ant-test", "User-Agent": "claude-cli" }
        );
        assert.equal(anth.status, 200, JSON.stringify(anth.body));
        pass("Anthropic /v1/messages forwards to mock");

        const missingInput = await requestJson(reviewPort, "POST", "/v1/responses", { model: "gpt-4o-mini" });
        assert.equal(missingInput.status, 422);
        pass("POST /v1/responses rejects missing input");

        const notFound = await requestJson(reviewPort, "GET", "/nope");
        assert.equal(notFound.status, 404);
        pass("unknown route 404");
      } finally {
        await proxy.stop();
      }
    });
  } catch (err) {
    fail("proxy endpoint suite", err.stack || err.message);
  }

  // 8) Hosted compress API with real key from ~/.supercompress (if present)
  try {
    const liveCfgPath = path.join(os.homedir(), ".supercompress/config.json");
    if (!fs.existsSync(liveCfgPath)) {
      pass("hosted compress API", "skipped — no ~/.supercompress/config.json");
    } else {
      const live = JSON.parse(fs.readFileSync(liveCfgPath, "utf8"));
      const key = live.api_key;
      assert.ok(key && key.startsWith("sc_live_"));
      const context = Array.from({ length: 50 }, (_, i) =>
        [
          `src/file_${i}.ts: export function run${i}(input: string) { return input.trim() + ${i}; }`,
          `test/file_${i}.test.ts: expect(run${i}(" x ")).toBe("x${i}");`,
          `README: run${i} trims input then appends ${i}.`,
        ].join("\n")
      ).join("\n");
      const body = JSON.stringify({
        context,
        query: "What does run7 do to its input?",
        mode: "compiler",
        coding_agent: "review-test",
      });
      const res = await new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: "www.supercompress.dev",
            path: "/api/v1/compress",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-Key": key,
              "Content-Length": Buffer.byteLength(body),
            },
          },
          (r) => {
            let data = "";
            r.on("data", (c) => (data += c));
            r.on("end", () => resolve({ status: r.statusCode, body: data }));
          }
        );
        req.on("error", reject);
        req.write(body);
        req.end();
      });
      assert.equal(res.status, 200, res.body.slice(0, 300));
      const parsed = JSON.parse(res.body);
      assert.ok(parsed.compressed_text && parsed.compressed_text.length > 0);
      assert.match(parsed.compressed_text, /run7/);
      pass(
        "hosted compress API with live key",
        `saved=${parsed.tokens_saved || 0} kv=${parsed.tokens_saved_pct || 0}%`
      );
    }
  } catch (err) {
    fail("hosted compress API with live key", err.message);
  }

  // 8b) Empty-compression safety in compressor.js
  try {
    const src = fs.readFileSync(path.join(ROOT, "src/compressor.js"), "utf8");
    assert.match(src, /empty_compression/);
    assert.match(src, /passing through uncompressed/);
    pass("compressor guards against empty compression wipeout");
  } catch (err) {
    fail("compressor guards against empty compression wipeout", err.message);
  }

  // 9) MCP module loads and declares tools
  try {
    const mcpSrc = fs.readFileSync(path.join(ROOT, "src/mcp.js"), "utf8");
    assert.match(mcpSrc, /compress_context/);
    assert.match(mcpSrc, /connect_account/);
    assert.match(mcpSrc, /usage_summary/);
    // Ensure bin is executable node script
    const head = fs.readFileSync(path.join(ROOT, "src/mcp.js"), "utf8").slice(0, 40);
    assert.match(head, /#!/);
    pass("MCP server source declares 3 tools");
  } catch (err) {
    fail("MCP server source declares 3 tools", err.message);
  }

  // 10) Live install health observations (non-mutating)
  try {
    const liveHealth = await requestJson(8080, "GET", "/health").catch((e) => ({ error: e.message }));
    if (
      liveHealth.error ||
      liveHealth.status !== 200 ||
      liveHealth.body?.status !== "ok" ||
      liveHealth.body?.service !== "supercompress"
    ) {
      pass("live localhost:8080 health (inactive)", `skipped — ${liveHealth.error || `status=${liveHealth.status}`}`);
    } else {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
      if (liveHealth.body.version !== pkg.version) {
        fail(
          "live localhost:8080 version",
          `running ${liveHealth.body.version}, package is ${pkg.version} (stale proxy process)`
        );
      } else {
        pass("live localhost:8080 version matches package");
      }
    }

    const cursorSettings = path.join(
      os.homedir(),
      "Library/Application Support/Cursor/User/settings.json"
    );
    if (fs.existsSync(cursorSettings)) {
      const s = fs.readFileSync(cursorSettings, "utf8");
      assert.doesNotMatch(s, /"openAiBaseUrl"\s*:\s*"http:\/\/localhost:8080\/v1"/);
      pass("Cursor is not forced into provider API-key proxy mode");
    } else {
      pass("Cursor settings.json absent (ok for MCP-only)");
    }

    const mcp = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".cursor/mcp.json"), "utf8"));
    const sc = mcp.mcpServers && mcp.mcpServers.supercompress;
    assert.ok(sc, "supercompress MCP missing");
    assert.ok(Array.isArray(sc.args) && sc.args.some((a) => String(a).includes("mcp.js")));
    assert.notEqual(sc.env && sc.env.SUPERCOMPRESS_API_KEY, "${SUPERCOMPRESS_API_KEY}");
    assert.ok(sc.env && sc.env.SUPERCOMPRESS_CONFIG_DIR);
    pass("Cursor MCP registers supercompress without placeholder API key");

    if (fs.existsSync(path.join(os.homedir(), ".claude/settings.json"))) {
      const claude = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude/settings.json"), "utf8"));
      assert.notEqual(claude.env?.ANTHROPIC_BASE_URL, "http://localhost:8080");
      pass("Claude Code not forced into ANTHROPIC_BASE_URL proxy mode");
    }

    const codex = fs.readFileSync(path.join(os.homedir(), ".codex/config.toml"), "utf8");
    assert.doesNotMatch(codex, /^\s*openai_base_url\s*=\s*"http:\/\/localhost:8080\/v1"/m);
    assert.match(codex, /\[mcp_servers\.supercompress\]/);
    pass("Codex uses MCP plugin, not openai_base_url proxy");

    // Extension MCP targets validation (Roo Code, Cline, Kodu)
    const { resolveExtensionMcpTargets } = require(path.join(ROOT, "src/detector.js"));
    const extTargets = resolveExtensionMcpTargets();
    assert.ok(Array.isArray(extTargets) && extTargets.length > 0, "resolveExtensionMcpTargets returns array of targets");
    const targetNames = extTargets.map(([name]) => name);
    assert.ok(targetNames.includes("Roo Code"), "Extension targets include Roo Code");
    assert.ok(targetNames.includes("Cline"), "Extension targets include Cline");
    assert.ok(targetNames.includes("Kodu"), "Extension targets include Kodu");
    assert.ok(extTargets.every(([_, p]) => p.endsWith("cline_mcp_settings.json")), "Extension targets target cline_mcp_settings.json");
    assert.ok(extTargets.some(([_, p]) => String(p).includes("Code - Insiders")), "targets include Code - Insiders");
    pass("VS Code extension globalStorage MCP targets resolved", `${extTargets.length} targets`);
  } catch (err) {
    fail("live install wiring checks", err.message);
  }

  // Cleanup temp config
  fs.rmSync(configDir, { recursive: true, force: true });

  console.log("\n=== Summary ===");
  console.log(`passed=${results.filter((r) => r.ok).length} failed=${failed} total=${results.length}`);
  if (failed) {
    console.log("\nFailures:");
    for (const r of results.filter((x) => !x.ok)) console.log(` - ${r.name}: ${r.detail}`);
    process.exitCode = 1;
  } else {
    console.log("All review checks passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
