#!/usr/bin/env node
/**
 * fx (Vercel Labs) wiring: ~/.fx/mcp.json + AGENTS.md + skills.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "bin", "supercompress.js");

function run(home, ...args) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 60000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      FX_HOME: path.join(home, ".fx"),
      PATH: `${path.join(home, "bin")}:${process.env.PATH || ""}`,
    },
  });
  assert.strictEqual(res.status, 0, `${args.join(" ")} exited ${res.status}: ${res.stderr}\n${res.stdout}`);
  return res.stdout;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sc-fx-"));
const fx = path.join(home, ".fx");
fs.mkdirSync(fx, { recursive: true });
fs.mkdirSync(path.join(home, "bin"), { recursive: true });
// Fake `fx` on PATH so detection can also hit via commandExists in some paths;
// presence of ~/.fx is enough for fxInstalled().
fs.writeFileSync(path.join(fx, "mcp.json"), JSON.stringify({ mcp: { other: { type: "http", url: "https://example.com" } } }, null, 2));

run(home, "plugin");

const mcp = JSON.parse(fs.readFileSync(path.join(fx, "mcp.json"), "utf8"));
assert.ok(mcp.mcp.supercompress, "registers fx MCP under mcp.supercompress");
assert.equal(mcp.mcp.supercompress.type, "local");
assert.ok(Array.isArray(mcp.mcp.supercompress.command), "fx uses command array");
assert.equal(mcp.mcp.supercompress.environment.SUPERCOMPRESS_AGENT_NAME, "fx");
assert.ok(mcp.mcp.other, "preserves other MCP servers");

const agentsMd = fs.readFileSync(path.join(fx, "AGENTS.md"), "utf8");
assert.match(agentsMd, /SuperCompress \(always on/);
assert.match(agentsMd, /mcp_search_tools|compress_context/);

const skill = fs.readFileSync(path.join(fx, "skills", "supercompress", "SKILL.md"), "utf8");
assert.match(skill, /compress_context/);

const connectOut = run(home, "agents", "connect");
assert.match(connectOut, /Agent Plugins 1\.0/);
assert.match(connectOut, /supercompress-mcp|mcp\.js/);

run(home, "uninstall");
const after = JSON.parse(fs.readFileSync(path.join(fx, "mcp.json"), "utf8"));
assert.ok(!after.mcp || !after.mcp.supercompress, "uninstall removes fx MCP");
assert.ok(
  !fs.existsSync(path.join(fx, "skills", "supercompress", "SKILL.md")),
  "uninstall removes fx skill"
);
if (fs.existsSync(path.join(fx, "AGENTS.md"))) {
  assert.doesNotMatch(
    fs.readFileSync(path.join(fx, "AGENTS.md"), "utf8"),
    /SuperCompress \(always on/
  );
}

console.log("fx-build: ok");
