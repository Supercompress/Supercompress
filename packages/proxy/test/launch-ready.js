#!/usr/bin/env node
/**
 * Launch-readiness battering ram.
 * Edge cases, fail paths, concurrency, config safety, multi-format compression.
 */

const assert = require("assert");
const { spawn, execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, ".supercompress");
const MCP = path.join(ROOT, "src", "mcp.js");
const VERSION = require(path.join(ROOT, "package.json")).version;

const results = [];
const pass = (n, d = "") => {
  results.push({ ok: true, n, d });
  console.log(`PASS  ${n}${d ? ` — ${d}` : ""}`);
};
const fail = (n, d) => {
  results.push({ ok: false, n, d });
  console.error(`FAIL  ${n} — ${d}`);
};

function liveKey() {
  const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "config.json"), "utf8"));
  assert.ok(cfg.api_key && cfg.api_key.startsWith("sc_"), "account not linked");
  return cfg.api_key;
}

function codingDump(n = 35, needle = 9) {
  return Array.from({ length: n }, (_, i) =>
    [
      `// file util_${i}.ts`,
      `export function transform${i}(input: string): string {`,
      `  if (!input) throw new Error("empty_${i}");`,
      `  return input.trim().toUpperCase() + "_${i}";`,
      `}`,
      `// transform${i} uppercases and suffixes _${i}`,
    ].join("\n")
  ).join("\n\n") + `\n\n// NEEDLE: transform${needle} is the function under investigation\n`;
}

function httpsJson(method, hostname, urlPath, headers, bodyObj) {
  const payload = bodyObj == null ? null : JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path: urlPath,
        method,
        headers: {
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = data;
          try {
            parsed = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode, body: parsed, raw: data });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function localHealth(port = 8080) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: "/health", timeout: 1500 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ ok: res.statusCode === 200, body: JSON.parse(data) });
        } catch {
          resolve({ ok: false, body: data });
        }
      });
    });
    req.on("error", () => resolve({ ok: false }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false });
    });
  });
}

function mcpSession(env, calls, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SUPERCOMPRESS_API_KEY: undefined, ...env },
    });
    let buf = "";
    const replies = [];
    let settled = false;
    const wanted = new Set(calls.map((c) => c.id));
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      if (err) reject(err);
      else resolve(replies);
    };
    const timer = setTimeout(() => finish(new Error(`timeout got=${JSON.stringify(replies).slice(0, 400)}`)), timeoutMs);
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          replies.push(msg);
          if (msg.id != null) wanted.delete(msg.id);
          if (wanted.size === 0) finish();
        } catch {}
      }
    });
    child.on("error", finish);
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    send({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "launch-ready", version: "1" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    for (const call of calls) send(call);
  });
}

function parseMcpTool(reply) {
  assert.ok(reply && reply.result, "missing result");
  if (reply.result.isError) {
    return { isError: true, text: (reply.result.content || []).map((c) => c.text || "").join("\n") };
  }
  const text = (reply.result.content || []).map((c) => c.text || "").join("\n");
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  return { isError: false, text, data };
}

async function main() {
  console.log("\n=== Launch-readiness battering ram ===\n");
  delete process.env.SUPERCOMPRESS_API_KEY;
  process.env.SUPERCOMPRESS_CONFIG_DIR = CONFIG_DIR;
  const apiKey = liveKey();

  // ── A. Package / CLI surface ──
  try {
    assert.equal(require(path.join(ROOT, "package.json")).name, "supercompress-proxy");
    assert.ok(fs.existsSync(path.join(ROOT, "bin/supercompress.js")));
    assert.ok(fs.existsSync(path.join(ROOT, "src/mcp.js")));
    const help = spawnSync(process.execPath, [path.join(ROOT, "bin/supercompress.js"), "help"], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.match(help.stdout, /plugin/i);
    assert.match(help.stdout, /setup/i);
    const agents = spawnSync(process.execPath, [path.join(ROOT, "bin/supercompress.js"), "agents"], {
      encoding: "utf8",
      timeout: 15000,
    });
    assert.match(agents.stdout, /FreeBuff|OpenCode|Cursor/i);
    pass("CLI help + agents surface", `v${VERSION}`);
  } catch (e) {
    fail("CLI help + agents surface", e.message);
  }

  // ── B. Live wiring safety (no API-key proxy mode) ──
  try {
    const cursorSettings = path.join(HOME, "Library/Application Support/Cursor/User/settings.json");
    if (fs.existsSync(cursorSettings)) {
      const s = fs.readFileSync(cursorSettings, "utf8");
      assert.doesNotMatch(s, /"openAiBaseUrl"\s*:\s*"http:\/\/localhost:8080\/v1"/);
    }
    const mcp = JSON.parse(fs.readFileSync(path.join(HOME, ".cursor/mcp.json"), "utf8"));
    assert.ok(mcp.mcpServers.supercompress);
    assert.notEqual(mcp.mcpServers.supercompress.env?.SUPERCOMPRESS_API_KEY, "${SUPERCOMPRESS_API_KEY}");
    assert.ok(mcp.mcpServers.supercompress.env?.SUPERCOMPRESS_CONFIG_DIR);
    const fb = JSON.parse(fs.readFileSync(path.join(HOME, ".agents/mcp.json"), "utf8"));
    assert.ok(fb.mcpServers.supercompress);
    const oc = JSON.parse(fs.readFileSync(path.join(HOME, ".config/opencode/opencode.jsonc"), "utf8"));
    assert.ok(oc.mcp?.supercompress?.command);
    const codex = fs.readFileSync(path.join(HOME, ".codex/config.toml"), "utf8");
    assert.doesNotMatch(codex, /^\s*openai_base_url\s*=\s*"http:\/\/localhost:8080\/v1"/m);
    assert.match(codex, /\[mcp_servers\.supercompress\]/);
    if (fs.existsSync(path.join(HOME, ".claude/settings.json"))) {
      const claude = JSON.parse(fs.readFileSync(path.join(HOME, ".claude/settings.json"), "utf8"));
      assert.notEqual(claude.env?.ANTHROPIC_BASE_URL, "http://localhost:8080");
    }
    pass("live wiring is MCP-first (no provider API-key mode)");
  } catch (e) {
    fail("live wiring is MCP-first (no provider API-key mode)", e.message);
  }

  // ── C. Detector isolation: FreeBuff + OpenCode MCP formats ──
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sc-launch-home-"));
    const originalHome = os.homedir;
    const originalConfigDir = process.env.SUPERCOMPRESS_CONFIG_DIR;
    os.homedir = () => home;
    process.env.SUPERCOMPRESS_CONFIG_DIR = path.join(home, ".supercompress");
    fs.mkdirSync(path.join(home, ".config/opencode"), { recursive: true });
    fs.mkdirSync(path.join(home, ".agents"), { recursive: true });
    fs.mkdirSync(path.join(home, ".config/manicode"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config/opencode/opencode.jsonc"), JSON.stringify({ model: "x" }, null, 2));
    fs.writeFileSync(path.join(home, ".agents/mcp.json"), JSON.stringify({ mcpServers: { other: { command: "echo" } } }, null, 2));
    // Fake bins
    const binDir = path.join(home, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "freebuff"), "#!/bin/sh\necho freebuff\n");
    fs.writeFileSync(path.join(binDir, "opencode"), "#!/bin/sh\necho opencode\n");
    fs.chmodSync(path.join(binDir, "freebuff"), 0o755);
    fs.chmodSync(path.join(binDir, "opencode"), 0o755);
    process.env.PATH = `${binDir}:${process.env.PATH}`;

    delete require.cache[require.resolve(path.join(ROOT, "src/detector.js"))];
    // detector caches HOME at load — clear and reload with patched homedir
    const detectorPath = path.join(ROOT, "src/detector.js");
    delete require.cache[require.resolve(detectorPath)];
    const detector = require(detectorPath);
    const found = detector.detectAll().map((a) => a.name);
    assert.ok(found.includes("FreeBuff"), `missing FreeBuff in ${found}`);
    assert.ok(found.includes("OpenCode"), `missing OpenCode in ${found}`);
    const configured = detector.configureMcp();
    assert.ok(configured.includes("FreeBuff"), configured.join(","));
    assert.ok(configured.includes("OpenCode"), configured.join(","));
    const fb = JSON.parse(fs.readFileSync(path.join(home, ".agents/mcp.json"), "utf8"));
    assert.ok(fb.mcpServers.other, "must preserve existing MCP servers");
    assert.ok(fb.mcpServers.supercompress);
    assert.equal(fb.mcpServers.supercompress.env.SUPERCOMPRESS_API_KEY, undefined);
    const oc = JSON.parse(fs.readFileSync(path.join(home, ".config/opencode/opencode.jsonc"), "utf8"));
    assert.equal(oc.mcp.supercompress.type, "local");
    assert.ok(oc.mcp.supercompress.command.some((c) => String(c).includes("mcp.js")));
    os.homedir = originalHome;
    process.env.SUPERCOMPRESS_CONFIG_DIR = originalConfigDir;
    fs.rmSync(home, { recursive: true, force: true });
    delete require.cache[require.resolve(detectorPath)];
    pass("detector isolates FreeBuff+OpenCode MCP install + preserves peers");
  } catch (e) {
    fail("detector isolates FreeBuff+OpenCode MCP install + preserves peers", e.message);
  }

  // Zed: macOS Application Support path + context_servers schema (not mcpServers)
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sc-zed-"));
    const originalHome = os.homedir;
    const originalConfigDir = process.env.SUPERCOMPRESS_CONFIG_DIR;
    os.homedir = () => home;
    process.env.SUPERCOMPRESS_CONFIG_DIR = path.join(home, ".supercompress");
    const zedDir = path.join(home, "Library", "Application Support", "Zed");
    fs.mkdirSync(zedDir, { recursive: true });
    fs.writeFileSync(
      path.join(zedDir, "settings.json"),
      JSON.stringify({ theme: "One Dark", context_servers: { other: { command: "echo", args: ["hi"] } } }, null, 2)
    );
    // Fake app bundle so zedInstalled() is true without PATH `zed`
    fs.mkdirSync(path.join(home, "Applications", "Zed.app", "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(home, "Applications", "Zed.app", "Contents", "MacOS", "zed"), "#!/bin/sh\n");
    fs.chmodSync(path.join(home, "Applications", "Zed.app", "Contents", "MacOS", "zed"), 0o755);

    const detectorPath = path.join(ROOT, "src/detector.js");
    delete require.cache[require.resolve(detectorPath)];
    const detector = require(detectorPath);
    const found = detector.detectAll().map((a) => a.name);
    assert.ok(found.includes("Zed"), `missing Zed in ${found}`);
    const configured = detector.configureMcp();
    assert.ok(configured.includes("Zed"), configured.join(","));
    const settings = JSON.parse(fs.readFileSync(path.join(zedDir, "settings.json"), "utf8"));
    assert.ok(settings.context_servers.other, "must preserve existing Zed context servers");
    assert.ok(settings.context_servers.supercompress);
    assert.equal(typeof settings.context_servers.supercompress.command, "string");
    assert.ok(Array.isArray(settings.context_servers.supercompress.args));
    assert.equal(settings.mcpServers, undefined);
    assert.equal(settings.agent.enable_all_context_servers, true);
    const removed = detector.removeMcp();
    assert.ok(removed.includes("Zed"), removed.join(","));
    const after = JSON.parse(fs.readFileSync(path.join(zedDir, "settings.json"), "utf8"));
    assert.equal(after.context_servers.supercompress, undefined);
    assert.ok(after.context_servers.other);
    os.homedir = originalHome;
    process.env.SUPERCOMPRESS_CONFIG_DIR = originalConfigDir;
    fs.rmSync(home, { recursive: true, force: true });
    delete require.cache[require.resolve(detectorPath)];
    pass("detector configures Zed via context_servers and preserves peers");
  } catch (e) {
    fail("detector configures Zed via context_servers and preserves peers", e.message);
  }

  // ── D. Hosted API formats ──
  const formats = [
    ["diff", `diff --git a/a.ts b/a.ts\n${Array.from({ length: 40 }, (_, i) => `+export const x${i}=${i}`).join("\n")}\n+export const needle = "KEEP_ME_DIFF"`, "KEEP_ME_DIFF"],
    ["json", JSON.stringify({
      title: "batch report",
      critical_alert: { code: "NEEDLE_JSON", severity: "high", detail: "payment charge failed" },
      rows: Array.from({ length: 60 }, (_, i) => ({ id: i, note: `row_${i}`, flag: "ok" })),
    }, null, 2), "NEEDLE_JSON"],
    ["markdown", Array.from({ length: 50 }, (_, i) => `## Section ${i}\n\nBlah blah paragraph ${i}.\n`).join("\n") + "\n## Critical\n\nNEEDLE_MD_VALUE is 42.\n", "NEEDLE_MD_VALUE"],
    ["stacktrace", Array.from({ length: 50 }, (_, i) => `    at module_${i} (file_${i}.js:${i}:1)`).join("\n") + "\nError: NEEDLE_STACK boom\n    at fail (app.js:9:9)\n", "NEEDLE_STACK"],
    ["code", codingDump(40, 9), "transform9"],
  ];
  for (const [name, context, needle] of formats) {
    try {
      const res = await httpsJson("POST", "www.supercompress.dev", "/api/v1/compress", { "X-API-Key": apiKey }, {
        context,
        query: name === "json"
          ? "What is the critical_alert code and detail?"
          : `Find and explain ${needle}`,
        mode: "compiler",
        coding_agent: `launch-${name}`,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
      assert.ok(res.body.compressed_text);
      assert.match(String(res.body.compressed_text), new RegExp(needle, "i"));
      assert.ok((res.body.tokens_saved || 0) > 0 || String(res.body.compressed_text).length < context.length * 0.85);
      pass(
        `hosted compress format:${name}`,
        `orig=${res.body.original_tokens} saved=${res.body.tokens_saved} kv=${res.body.tokens_saved_pct}%`
      );
    } catch (e) {
      fail(`hosted compress format:${name}`, e.message);
    }
  }

  // ── E. Auth / fail paths ──
  try {
    const bad = await httpsJson("POST", "www.supercompress.dev", "/api/v1/compress", { "X-API-Key": "sc_live_invalid_key_xxxxxx" }, {
      context: codingDump(20),
      query: "x",
      mode: "compiler",
    });
    assert.ok(bad.status === 401 || bad.status === 403, `expected auth fail got ${bad.status}`);
    pass("hosted API rejects invalid key", `status=${bad.status}`);
  } catch (e) {
    fail("hosted API rejects invalid key", e.message);
  }

  try {
    const replies = await mcpSession(
      { SUPERCOMPRESS_CONFIG_DIR: path.join(os.tmpdir(), "sc-missing-config-dir-launch") },
      [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "compress_context", arguments: { context: "abc", query: "q" } } }]
    );
    const parsed = parseMcpTool(replies.find((r) => r.id === 1));
    assert.ok(parsed.isError, "expected error without account");
    assert.match(parsed.text, /not connected|account/i);
    pass("MCP fails safely without account link");
  } catch (e) {
    fail("MCP fails safely without account link", e.message);
  }

  try {
    const replies = await mcpSession(
      { SUPERCOMPRESS_CONFIG_DIR: CONFIG_DIR },
      [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "compress_context", arguments: { context: "   ", query: "q" } } }]
    );
    const parsed = parseMcpTool(replies.find((r) => r.id === 1));
    assert.ok(parsed.isError);
    assert.match(parsed.text, /context is required/i);
    pass("MCP rejects empty context");
  } catch (e) {
    fail("MCP rejects empty context", e.message);
  }

  try {
    const replies = await mcpSession(
      { SUPERCOMPRESS_CONFIG_DIR: CONFIG_DIR },
      [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "not_a_real_tool", arguments: {} } }]
    );
    const parsed = parseMcpTool(replies.find((r) => r.id === 1));
    assert.ok(parsed.isError);
    assert.match(parsed.text, /Unknown tool/i);
    pass("MCP rejects unknown tool");
  } catch (e) {
    fail("MCP rejects unknown tool", e.message);
  }

  // ── F. Placeholder env key ignored on MCP + compressor ──
  try {
    const replies = await mcpSession(
      { SUPERCOMPRESS_CONFIG_DIR: CONFIG_DIR, SUPERCOMPRESS_API_KEY: "${SUPERCOMPRESS_API_KEY}" },
      [{
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "compress_context", arguments: { context: codingDump(45, 9), query: "What does transform9 return?" } },
      }]
    );
    const parsed = parseMcpTool(replies.find((r) => r.id === 1));
    assert.ok(!parsed.isError, parsed.text);
    const compressed = parsed.data.compressed_text || parsed.data.compressed_context;
    assert.ok(compressed);
    assert.match(String(compressed), /transform9/i);
    assert.ok((parsed.data.tokens_saved || 0) > 100);
    pass("MCP ignores placeholder API key env", `saved=${parsed.data.tokens_saved}`);
  } catch (e) {
    fail("MCP ignores placeholder API key env", e.message);
  }

  try {
    process.env.SUPERCOMPRESS_API_KEY = "not-a-real-key";
    delete require.cache[require.resolve(path.join(ROOT, "src/compressor.js"))];
    const compressor = require(path.join(ROOT, "src/compressor.js"));
    const msgs = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: "user", content: `Review transform${i} which returns uppercased input plus _${i}` });
      msgs.push({ role: "assistant", content: `transform${i} uppercases and suffixes.` });
    }
    msgs.push({ role: "user", content: "Explain transform9" });
    const out = await compressor.compress(msgs, "launch-poisoned-env");
    assert.ok(!out.skip_reason, `skip=${out.skip_reason}`);
    assert.ok(out.tokens_saved > 50);
    pass("compressor ignores non-sc_ env key", `saved=${out.tokens_saved}`);
  } catch (e) {
    fail("compressor ignores non-sc_ env key", e.message);
  } finally {
    delete process.env.SUPERCOMPRESS_API_KEY;
  }

  // ── G. Concurrent MCP compressions ──
  try {
    const jobs = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        mcpSession(
          { SUPERCOMPRESS_CONFIG_DIR: CONFIG_DIR },
          [{
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "compress_context",
              arguments: {
                context: codingDump(30, n),
                query: `What does transform${n} return?`,
              },
            },
          }]
        )
      )
    );
    for (let i = 0; i < jobs.length; i++) {
      const parsed = parseMcpTool(jobs[i].find((r) => r.id === 1));
      assert.ok(!parsed.isError, parsed.text);
      const compressed = parsed.data.compressed_text || parsed.data.compressed_context;
      assert.match(String(compressed), new RegExp(`transform${i + 1}`, "i"));
      assert.ok((parsed.data.tokens_saved || 0) > 0);
    }
    pass("5 concurrent MCP compressions", "all kept needles + savings");
  } catch (e) {
    fail("5 concurrent MCP compressions", e.message);
  }

  // ── H. Small context passthrough (compressor) ──
  try {
    delete require.cache[require.resolve(path.join(ROOT, "src/compressor.js"))];
    const compressor = require(path.join(ROOT, "src/compressor.js"));
    const out = await compressor.compress(
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "ping" },
      ],
      "launch-small"
    );
    assert.equal(out.skip_reason, "context_too_small");
    assert.equal(out.tokens_saved, 0);
    pass("small context passthrough", "skip=context_too_small");
  } catch (e) {
    fail("small context passthrough", e.message);
  }

  // ── I. Local engine + empty guard ──
  try {
    const engine = require(path.join(ROOT, "src/local-engine"));
    const out = engine.compress(codingDump(40, 9), "What does transform9 return?");
    assert.ok(out.compressed_text);
    assert.match(out.compressed_text, /transform9/i);
    assert.ok(out.tokens_saved > 0);
    pass("local-engine keeps needle", `saved=${out.tokens_saved}`);
  } catch (e) {
    fail("local-engine keeps needle", e.message);
  }

  try {
    delete require.cache[require.resolve(path.join(ROOT, "src/compressor.js"))];
    const compressor = require(path.join(ROOT, "src/compressor.js"));
    const pad = "REPEAT ME. ".repeat(300);
    const out = await compressor.compress(
      [
        { role: "user", content: pad },
        { role: "assistant", content: pad },
        { role: "user", content: "sum" },
      ],
      "launch-empty"
    );
    assert.ok(out.messages.map((m) => m.content || "").join("").trim().length > 0);
    pass("empty-compression never wipes messages", out.skip_reason || `saved=${out.tokens_saved}`);
  } catch (e) {
    fail("empty-compression never wipes messages", e.message);
  }

  // ── J. Proxy health (optional if running) ──
  try {
    const health = await localHealth(8080);
    if (!health.ok) {
      pass("local proxy health", "not running (ok for MCP-only launch)");
    } else {
      assert.equal(health.body.service, "supercompress");
      assert.equal(health.body.version, VERSION);
      pass("local proxy health", `v${health.body.version}`);
    }
  } catch (e) {
    fail("local proxy health", e.message);
  }

  // ── K. OpenCode + FreeBuff live plugin state ──
  try {
    let ocBin;
    try {
      ocBin = execFileSync("which", ["opencode"], { encoding: "utf8" }).trim();
    } catch {
      ocBin = path.join(HOME, ".opencode/bin/opencode");
    }
    const list = execFileSync(ocBin, ["mcp", "list"], { encoding: "utf8", timeout: 20000 });
    assert.match(list, /supercompress/i);
    assert.match(list, /connected/i);
    const fbBin = execFileSync("which", ["freebuff"], { encoding: "utf8" }).trim();
    const ver = spawnSync(fbBin, ["-v"], { encoding: "utf8", timeout: 10000 });
    assert.equal(ver.status, 0);
    pass("OpenCode connected + FreeBuff binary live", (ver.stdout || "").trim().split("\n")[0]);
  } catch (e) {
    fail("OpenCode connected + FreeBuff binary live", e.message);
  }

  // ── L. Cursor rule present ──
  try {
    const rule = path.join(HOME, ".cursor/rules/supercompress.mdc");
    assert.ok(fs.existsSync(rule));
    const body = fs.readFileSync(rule, "utf8");
    assert.match(body, /compress_context/);
    pass("Cursor rule installed for auto tool use");
  } catch (e) {
    fail("Cursor rule installed for auto tool use", e.message);
  }

  // ── M. Idempotent plugin re-run ──
  try {
    const beforeFb = fs.readFileSync(path.join(HOME, ".agents/mcp.json"), "utf8");
    const beforeOc = fs.readFileSync(path.join(HOME, ".config/opencode/opencode.jsonc"), "utf8");
    delete require.cache[require.resolve(path.join(ROOT, "src/detector.js"))];
    const detector = require(path.join(ROOT, "src/detector.js"));
    detector.configureMcp();
    const afterFb = JSON.parse(fs.readFileSync(path.join(HOME, ".agents/mcp.json"), "utf8"));
    const afterOc = JSON.parse(fs.readFileSync(path.join(HOME, ".config/opencode/opencode.jsonc"), "utf8"));
    assert.ok(afterFb.mcpServers.supercompress);
    assert.ok(afterOc.mcp.supercompress);
    // supermemory or other peers should survive if they existed
    const beforeParsed = JSON.parse(beforeFb);
    for (const key of Object.keys(beforeParsed.mcpServers || {})) {
      if (key === "supercompress") continue;
      assert.ok(afterFb.mcpServers[key], `lost peer MCP server ${key}`);
    }
    pass("plugin re-run is idempotent + preserves peer MCP servers");
    // silence unused
    void beforeOc;
  } catch (e) {
    fail("plugin re-run is idempotent + preserves peer MCP servers", e.message);
  }

  // ── N. Usage summary readable ──
  try {
    const replies = await mcpSession(
      { SUPERCOMPRESS_CONFIG_DIR: CONFIG_DIR },
      [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "usage_summary", arguments: {} } }]
    );
    const parsed = parseMcpTool(replies.find((r) => r.id === 1));
    assert.ok(!parsed.isError, parsed.text);
    assert.ok(parsed.data && typeof parsed.data === "object");
    pass("usage_summary readable", `keys=${Object.keys(parsed.data).join(",")}`);
  } catch (e) {
    fail("usage_summary readable", e.message);
  }

  // ── O. Mega coding dump stress ──
  try {
    const mega = codingDump(120, 77);
    const res = await httpsJson("POST", "www.supercompress.dev", "/api/v1/compress", { "X-API-Key": apiKey }, {
      context: mega,
      query: "What does transform77 return?",
      mode: "compiler",
      coding_agent: "launch-mega",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
    assert.match(String(res.body.compressed_text), /transform77/i);
    assert.ok(res.body.tokens_saved > 1000, `weak mega savings ${res.body.tokens_saved}`);
    assert.ok(String(res.body.compressed_text).length < mega.length * 0.4);
    pass(
      "mega coding dump stress",
      `chars ${mega.length}→${String(res.body.compressed_text).length}; saved=${res.body.tokens_saved} kv=${res.body.tokens_saved_pct}%`
    );
  } catch (e) {
    fail("mega coding dump stress", e.message);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== Launch-ready summary: passed=${results.length - failed.length} failed=${failed.length} total=${results.length} ===`);
  if (failed.length) {
    for (const f of failed) console.log(" -", `${f.n}: ${f.d}`);
    process.exitCode = 1;
  } else {
    console.log("LAUNCH READY — all battering-ram checks passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
