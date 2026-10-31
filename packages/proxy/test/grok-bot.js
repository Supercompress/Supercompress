#!/usr/bin/env node
/**
 * Grok Bot hosted MCP: always catalogued + setup writes paste-ready URL snippet.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "bin", "supercompress.js");
const HOSTED = "https://www.supercompress.dev/api/mcp";

function run(home, configDir, ...args) {
  const allowNonZero = args[0] === "doctor";
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 60000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SUPERCOMPRESS_CONFIG_DIR: configDir,
    },
  });
  if (!allowNonZero) {
    assert.strictEqual(
      res.status,
      0,
      `${args.join(" ")} exited ${res.status}: ${res.stderr}\n${res.stdout}`
    );
  }
  return `${res.stdout}\n${res.stderr}`;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sc-grok-bot-"));
const configDir = path.join(home, ".supercompress");

const agentsOut = run(home, configDir, "agents");
assert.match(agentsOut, /Grok Bot/, "agents catalog lists Grok Bot");
assert.match(agentsOut, /Auto MCP plugin[\s\S]*Grok Bot/, "Grok Bot is in auto MCP list");

const pluginOut = run(home, configDir, "plugin");
assert.match(pluginOut, /Grok Bot/, "plugin configures Grok Bot");
assert.match(pluginOut, /Add this MCP server: https:\/\/www\.supercompress\.dev\/api\/mcp/, "prints hosted install line");

const mcpPath = path.join(configDir, "hosts", "grok-bot", "mcp.json");
assert.ok(fs.existsSync(mcpPath), "writes ~/.supercompress/hosts/grok-bot/mcp.json");
const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
assert.equal(mcp.mcpServers.supercompress.url, HOSTED);
assert.match(mcp.install, /Add this MCP server/);

const installTxt = fs.readFileSync(path.join(configDir, "hosts", "grok-bot", "INSTALL.txt"), "utf8");
assert.match(installTxt, /Add this MCP server: https:\/\/www\.supercompress\.dev\/api\/mcp/);

const doctorOut = run(home, configDir, "doctor");
assert.match(doctorOut, /Grok Bot/, "doctor surfaces Grok Bot");

console.log("✔ grok-bot hosted MCP");
