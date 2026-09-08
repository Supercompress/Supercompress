#!/usr/bin/env node
/**
 * Bug-hunt suite — asserts the errors we found stay fixed.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const HOME = os.homedir();
const results = [];
const pass = (n, d = "") => {
  results.push({ ok: true, n, d });
  console.log(`PASS  ${n}${d ? ` — ${d}` : ""}`);
};
const fail = (n, d) => {
  results.push({ ok: false, n, d });
  console.error(`FAIL  ${n} — ${d}`);
};

async function main() {
  console.log("\n=== Bug-hunt regression ===\n");

  // 1) Codex MCP path must be refreshed (not stale global npm path)
  try {
    delete require.cache[require.resolve(path.join(ROOT, "src/detector.js"))];
    const detector = require(path.join(ROOT, "src/detector.js"));
    detector.configureMcp();
    const codexFile = path.join(HOME, ".codex/config.toml");
    if (fs.existsSync(codexFile)) {
      const raw = fs.readFileSync(codexFile, "utf8");
      assert.match(raw, /\[mcp_servers\.supercompress\]/);
      assert.match(raw, /packages\/proxy\/src\/mcp\.js/);
      assert.doesNotMatch(raw, /@agents-npm-packages\/supercompress/);
      assert.match(raw, /SUPERCOMPRESS_CONFIG_DIR/);
      pass("Codex MCP points at current package (not stale global)");
    } else {
      pass("Codex MCP (skipped)", "~/.codex/config.toml not present");
    }
  } catch (e) {
    fail("Codex MCP points at current package (not stale global)", e.message);
  }

  // 2) OpenCode write must refuse to wipe on corrupt config
  try {
    delete require.cache[require.resolve(path.join(ROOT, "src/detector.js"))];
    // Force re-read of detector internals via configure path using temp home
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sc-openc-wipe-"));
    const originalHome = os.homedir;
    os.homedir = () => home;
    process.env.SUPERCOMPRESS_CONFIG_DIR = path.join(home, ".supercompress");
    fs.mkdirSync(path.join(home, ".config/opencode"), { recursive: true });
    fs.mkdirSync(path.join(home, ".opencode/bin"), { recursive: true });
    fs.writeFileSync(path.join(home, ".opencode/bin/opencode"), "#!/bin/sh\n");
    fs.chmodSync(path.join(home, ".opencode/bin/opencode"), 0o755);
    process.env.PATH = `${path.join(home, ".opencode/bin")}:${process.env.PATH}`;
    const badPath = path.join(home, ".config/opencode/opencode.jsonc");
    fs.writeFileSync(badPath, "{ model: not-json,,, }\n");
    delete require.cache[require.resolve(path.join(ROOT, "src/detector.js"))];
    const detector = require(path.join(ROOT, "src/detector.js"));
    let threw = false;
    try {
      detector.configureMcp();
    } catch {
      threw = true;
    }
    // configureMcp catches and logs — verify file not wiped to empty mcp-only object
    const after = fs.readFileSync(badPath, "utf8");
    assert.equal(after, "{ model: not-json,,, }\n", "corrupt OpenCode config was overwritten");
    assert.match(after, /not-json/);
    os.homedir = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
    delete require.cache[require.resolve(path.join(ROOT, "src/detector.js"))];
    pass("OpenCode corrupt config is not wiped", threw ? "threw" : "left intact via catch");
  } catch (e) {
    fail("OpenCode corrupt config is not wiped", e.message);
  }

  // 3) Rate-limit helper includes limit
  try {
    // Local unit: re-implement check from source
    const httpSrc = fs.readFileSync(
      path.join(ROOT, "../../api/_lib/http.js"),
      "utf8"
    );
    assert.match(httpSrc, /limit:\s*maxRequests/);
    assert.match(httpSrc, /limit:\s*rl\.limit/);
    pass("rate-limit headers include numeric limit");
  } catch (e) {
    fail("rate-limit headers include numeric limit", e.message);
  }

  // 4) coding agent usage helpers exist
  try {
    const storeSrc = fs.readFileSync(
      path.join(ROOT, "../../api/_lib/store.js"),
      "utf8"
    );
    assert.match(storeSrc, /trackCodingAgentUsage/);
    assert.match(storeSrc, /coding_agent_usage/);
    const compressSrc = fs.readFileSync(
      path.join(ROOT, "../../api/v1/compress.js"),
      "utf8"
    );
    assert.match(compressSrc, /trackCodingAgentUsage/);
    pass("coding-agent usage uses dedicated tracker");
  } catch (e) {
    fail("coding-agent usage uses dedicated tracker", e.message);
  }

  // 5) Live MCP paths all point at this package (PATH `node`, not Cellar-pinned execPath)
  try {
    const expected = path.join(ROOT, "src/mcp.js");
    const cursorFile = path.join(HOME, ".cursor/mcp.json");
    if (fs.existsSync(cursorFile)) {
      const cursor = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
      if (cursor.mcpServers?.supercompress) {
        assert.equal(cursor.mcpServers.supercompress.command, "node");
        assert.ok(cursor.mcpServers.supercompress.args.includes(expected));
      }
    }
    const fbFile = path.join(HOME, ".agents/mcp.json");
    if (fs.existsSync(fbFile)) {
      const fb = JSON.parse(fs.readFileSync(fbFile, "utf8"));
      if (fb.mcpServers?.supercompress) {
        assert.equal(fb.mcpServers.supercompress.command, "node");
        assert.ok(fb.mcpServers.supercompress.args.includes(expected));
      }
    }
    const ocFile = path.join(HOME, ".config/opencode/opencode.jsonc");
    if (fs.existsSync(ocFile)) {
      const oc = JSON.parse(fs.readFileSync(ocFile, "utf8"));
      if (oc.mcp?.supercompress?.command) {
        const ocCmd = oc.mcp.supercompress.command;
        assert.ok(Array.isArray(ocCmd), "OpenCode command must be an array");
        assert.equal(ocCmd[0], "node");
        assert.ok(ocCmd.includes(expected));
      }
    }
    pass("Cursor/FreeBuff/OpenCode MCP paths are current");
  } catch (e) {
    fail("Cursor/FreeBuff/OpenCode MCP paths are current", e.message);
  }

  // 6) plugin command refreshes without forcing API-key mode
  try {
    const out = spawnSync(process.execPath, [path.join(ROOT, "bin/supercompress.js"), "plugin"], {
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(out.status, 0, out.stderr || out.stdout);
    assert.match(out.stdout, /Detected \d+ coding agent|MCP plugin installed/i);
    const settings = path.join(HOME, "Library/Application Support/Cursor/User/settings.json");
    if (fs.existsSync(settings)) {
      assert.doesNotMatch(fs.readFileSync(settings, "utf8"), /"openAiBaseUrl"\s*:\s*"http:\/\/localhost:8080\/v1"/);
    }
    pass("plugin refresh keeps MCP-first mode");
  } catch (e) {
    fail("plugin refresh keeps MCP-first mode", e.message);
  }

  // 7) chunkText preserves surrogate pairs across chunk boundaries (Fixes #146)
  try {
    const { chunkText } = require(path.join(ROOT, "src/cursor-hooks/compress-prompt-lib.js"));

    // Case A: Emoji landing across boundary with maxChars = 100
    const str1 = "a".repeat(99) + "🚀" + "b".repeat(10);
    const chunks1 = chunkText(str1, 100);
    assert.equal(chunks1.join(""), str1, "joined chunks must equal original string");
    assert.equal(chunks1[0], "a".repeat(99), "chunk 0 should not split surrogate pair");
    assert.ok(chunks1[1].startsWith("🚀"), "chunk 1 should begin with intact emoji");
    assert.ok(!JSON.stringify(chunks1[0]).includes("\\ufffd"), "chunk 0 must not contain replacement char");
    assert.ok(!JSON.stringify(chunks1[1]).includes("\\ufffd"), "chunk 1 must not contain replacement char");

    // Case B: Non-BMP mathematical symbol (𝒳 = \uD835\uDCB3) and CJK extension (𠮷 = \uD842\uDFB7)
    const str2 = "x".repeat(49) + "𝒳" + "y".repeat(47) + "𠮷" + "z";
    const chunks2 = chunkText(str2, 50);
    assert.equal(chunks2.join(""), str2, "joined chunks must equal original string");
    assert.ok(chunks2[1].startsWith("𝒳"), "surrogate pair 𝒳 kept intact");
    assert.ok(chunks2[2].startsWith("𠮷"), "surrogate pair 𠮷 kept intact");
    for (const c of chunks2) {
      assert.ok(!JSON.stringify(c).includes("\\ufffd"), "no replacement characters in chunks");
    }

    // Case C: Full scale test matching issue reproduction (120,000 maxChars)
    const context = "a".repeat(119999) + "🚀" + "b".repeat(10);
    const chunksLarge = chunkText(context, 120000);
    assert.equal(chunksLarge.join(""), context);
    assert.equal(chunksLarge[0].charCodeAt(chunksLarge[0].length - 1), 0x61, "chunk 0 ends with 'a'");
    assert.ok(chunksLarge[1].startsWith("🚀"), "chunk 1 starts with full emoji");
    assert.ok(!JSON.stringify(chunksLarge[0]).includes("\\ufffd"));
    assert.ok(!JSON.stringify(chunksLarge[1]).includes("\\ufffd"));

    // Case D: Surrogate pair ending exactly at boundary should not step back
    const str3 = "a".repeat(98) + "🚀" + "b".repeat(10);
    const chunks3 = chunkText(str3, 100);
    assert.equal(chunks3.join(""), str3);
    assert.equal(chunks3[0], "a".repeat(98) + "🚀", "chunk 0 contains full surrogate pair when aligned at boundary");
    assert.equal(chunks3[1], "b".repeat(10));

    pass("chunkText preserves surrogate pairs across chunk boundaries (Fixes #146)");
  } catch (e) {
    fail("chunkText preserves surrogate pairs across chunk boundaries (Fixes #146)", e.message);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== Bug-hunt summary: passed=${results.length - failed.length} failed=${failed.length} total=${results.length} ===`);
  if (failed.length) {
    for (const f of failed) console.log(" -", `${f.n}: ${f.d}`);
    process.exitCode = 1;
  } else {
    console.log("All hunted bugs stay fixed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
