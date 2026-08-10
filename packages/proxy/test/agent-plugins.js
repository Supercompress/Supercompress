#!/usr/bin/env node
/**
 * Agent plugin adapters — Hermes / OpenClaw / custom registry.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sc-agent-plugins-"));
const cfg = path.join(tmp, "sc");

const script = `
process.env.SUPERCOMPRESS_CONFIG_DIR = ${JSON.stringify(cfg)};
process.env.HOME = ${JSON.stringify(tmp)};
const ap = require(${JSON.stringify(path.join(ROOT, "src/agent-plugins.js"))});
const fs = require("fs");
const path = require("path");

// Built-in format writers
const hermes = path.join(${JSON.stringify(tmp)}, ".hermes", "config.yaml");
const openclaw = path.join(${JSON.stringify(tmp)}, ".openclaw", "openclaw.json");
fs.mkdirSync(path.dirname(hermes), { recursive: true });
fs.writeFileSync(hermes, "model: gpt\\nother: true\\n");
ap.writeHermesYaml(hermes);
ap.writeOpenClawJson(openclaw);
const hy = fs.readFileSync(hermes, "utf8");
if (!/mcp_servers:[\\s\\S]*supercompress:[\\s\\S]*command:/.test(hy)) {
  throw new Error("hermes yaml missing supercompress\\n" + hy);
}
if (!/model: gpt/.test(hy)) throw new Error("hermes wiped unrelated keys");
const oj = JSON.parse(fs.readFileSync(openclaw, "utf8"));
if (!oj.mcp.servers.supercompress.command) throw new Error("openclaw missing server");

// Custom plugin: no --config → defaults, always installs, writes AGENTS.md
const { plugin } = ap.addCustomPlugin({
  id: "demo",
  name: "Demo",
  format: "mcp-json",
  detectCommands: ["demo-cli"],
});
if (!plugin.configPath) throw new Error("missing default configPath");
if (!fs.existsSync(plugin.configPath)) throw new Error("custom mcp-json not written");
const demo = JSON.parse(fs.readFileSync(plugin.configPath, "utf8"));
if (!demo.mcpServers.supercompress) throw new Error("custom mcp-json failed");
if (!fs.existsSync(plugin.instructionPath)) throw new Error("AGENTS.md not written for custom");
const agentsMd = fs.readFileSync(plugin.instructionPath, "utf8");
if (!/compress_context/.test(agentsMd)) throw new Error("instruction body missing");

// Drop-in plugins/*.json with enabled:true
const drop = path.join(ap.PLUGINS_DIR, "dropin.json");
fs.mkdirSync(ap.PLUGINS_DIR, { recursive: true });
fs.writeFileSync(drop, JSON.stringify({
  id: "dropin",
  name: "DropIn",
  format: "mcp-json",
  configPath: path.join(${JSON.stringify(tmp)}, ".dropin", "mcp.json"),
  enabled: true,
}, null, 2));
const configured = ap.configurePluginAgents();
if (!configured.includes("DropIn") && !configured.includes("Demo")) {
  // Demo already installed; DropIn must appear
}
if (!configured.includes("DropIn")) throw new Error("drop-in plugin not configured: " + configured.join(","));
if (!fs.existsSync(path.join(${JSON.stringify(tmp)}, ".dropin", "mcp.json"))) {
  throw new Error("drop-in mcp file missing");
}

// wrap resolution
const wrap = ap.resolveWrapSpec("demo");
if (!wrap || wrap.bin !== "demo-cli") throw new Error("resolveWrapSpec failed");

ap.removeCustomPlugin("demo");
const after = JSON.parse(fs.readFileSync(plugin.configPath, "utf8"));
if (after.mcpServers && after.mcpServers.supercompress) throw new Error("custom remove failed");

console.log("agent-plugins ok");
`;

const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
if (r.status !== 0) {
  process.stderr.write(r.stderr || r.stdout || "fail\n");
  process.exit(r.status || 1);
}
process.stdout.write(r.stdout);
assert.match(r.stdout, /agent-plugins ok/);
