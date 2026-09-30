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

// OpenClaw auto-compress parity (skill + hooks + plugin + config enable)
const ocHome = path.join(${JSON.stringify(tmp)}, ".openclaw");
const ocAuto = ap.writeOpenClawAutoCompress(ocHome);
if (!ocAuto.installed.includes("mcp")) throw new Error("openclaw auto missing mcp");
if (!ocAuto.installed.includes("skill")) throw new Error("openclaw auto missing skill");
if (!ocAuto.installed.includes("hooks")) throw new Error("openclaw auto missing hooks");
if (!ocAuto.installed.includes("plugin")) throw new Error("openclaw auto missing plugin");
if (!fs.existsSync(path.join(ocHome, "skills", "supercompress", "SKILL.md"))) {
  throw new Error("openclaw skill not written");
}
if (!fs.existsSync(path.join(ocHome, "hooks", "supercompress-bootstrap", "handler.js"))) {
  throw new Error("openclaw bootstrap hook missing");
}
if (!fs.existsSync(path.join(ocHome, "extensions", "supercompress", "index.js"))) {
  throw new Error("openclaw plugin missing");
}
const ocCfg = JSON.parse(fs.readFileSync(path.join(ocHome, "openclaw.json"), "utf8"));
if (!ocCfg.hooks?.internal?.enabled) throw new Error("openclaw hooks not enabled");
if (!ocCfg.hooks?.internal?.entries?.["supercompress-bootstrap"]?.enabled) {
  throw new Error("openclaw bootstrap hook not enabled in config");
}
if (!ocCfg.plugins?.entries?.supercompress?.enabled) throw new Error("openclaw plugin not enabled");
if (!ocCfg.mcp?.servers?.supercompress?.env?.SUPERCOMPRESS_CONFIG_DIR) {
  throw new Error("openclaw mcp env missing CONFIG_DIR");
}
const agentsOc = fs.readFileSync(path.join(ocHome, "AGENTS.md"), "utf8");
if (!/compress_context/.test(agentsOc)) throw new Error("openclaw AGENTS.md missing instructions");
if (!/inbox\\/<sessionId>\\/latest\\.md/.test(agentsOc)) {
  throw new Error("openclaw AGENTS.md missing session-scoped inbox path");
}

// Exact plugin path match: unrelated .../extensions/supercompress-backup must survive uninstall
const backupPath = path.join(ocHome, "extensions", "supercompress-backup");
fs.mkdirSync(backupPath, { recursive: true });
fs.writeFileSync(path.join(backupPath, "marker.txt"), "keep");
const cfgBeforeUninstall = JSON.parse(fs.readFileSync(path.join(ocHome, "openclaw.json"), "utf8"));
cfgBeforeUninstall.plugins.load.paths.push(backupPath);
fs.writeFileSync(path.join(ocHome, "openclaw.json"), JSON.stringify(cfgBeforeUninstall, null, 2));
if (!ap.sameAbsPath(ocAuto.pluginDest, path.join(ocHome, "extensions", "supercompress"))) {
  throw new Error("sameAbsPath failed for installed plugin dest");
}
if (ap.sameAbsPath(ocAuto.pluginDest, backupPath)) {
  throw new Error("sameAbsPath incorrectly matched backup path");
}

const ocRemoved = ap.removeOpenClawAutoCompressArtifacts(ocHome);
if (!ocRemoved.length) throw new Error("openclaw uninstall removed nothing");
if (fs.existsSync(path.join(ocHome, "skills", "supercompress"))) {
  throw new Error("openclaw skill still present after uninstall");
}
if (!fs.existsSync(path.join(backupPath, "marker.txt"))) {
  throw new Error("uninstall deleted unrelated extensions/supercompress-backup");
}
const ocAfter = JSON.parse(fs.readFileSync(path.join(ocHome, "openclaw.json"), "utf8"));
if (ocAfter.mcp?.servers?.supercompress) throw new Error("openclaw mcp still present after uninstall");
if (ocAfter.plugins?.entries?.supercompress) throw new Error("openclaw plugin entry still present");
if (!(ocAfter.plugins?.load?.paths || []).includes(backupPath)) {
  throw new Error("uninstall stripped unrelated plugin load path");
}

// Session-scoped inbox + compactSessionMemory smoke (no network)
const lib = require(${JSON.stringify(path.join(ROOT, "src/cursor-hooks/compress-prompt-lib.js"))});
const inboxA = lib.writeInbox("ask A", "digest A", "1→1", { session_id: "sessA", kind: "test" });
const inboxB = lib.writeInbox("ask B", "digest B", "1→1", { session_id: "sessB", kind: "test" });
if (inboxA === inboxB) throw new Error("session inboxes must not share a path");
if (!inboxA.includes(${JSON.stringify(path.sep + "sessA" + path.sep)})) {
  throw new Error("sessA inbox path wrong: " + inboxA);
}
if (lib.readInboxDigest("sessA").includes("digest B")) {
  throw new Error("cross-session inbox leak");
}
if (!lib.readInboxDigest("sessA").includes("digest A")) {
  throw new Error("sessA digest missing");
}
const globalLatest = path.join(lib.INBOX_DIR, "latest.md");
if (!fs.existsSync(globalLatest) || !fs.readFileSync(globalLatest, "utf8").includes("digest B")) {
  throw new Error("session write must mirror to inbox/latest.md");
}
if (typeof lib.readFreshInboxDigest !== "function") {
  throw new Error("readFreshInboxDigest missing");
}
if (!lib.readFreshInboxDigest("sessB").includes("digest B")) {
  throw new Error("readFreshInboxDigest should find sessB");
}
if (typeof lib.compactSessionMemory !== "function") {
  throw new Error("compactSessionMemory missing");
}
if (lib.chunkText("x".repeat(250000), 120000).length !== 3) {
  throw new Error("chunkText should split above API max");
}

// Plugin source must not hardcode ~/.supercompress/inbox/latest.md
const pluginAsset = fs.readFileSync(
  path.join(${JSON.stringify(ROOT)}, "src/openclaw-hooks/plugin/index.js"),
  "utf8"
);
if (pluginAsset.includes(".supercompress/inbox/latest.md")) {
  throw new Error("OpenClaw plugin still hardcodes global inbox/latest.md");
}
if (!/readInboxDigest/.test(pluginAsset)) {
  throw new Error("OpenClaw plugin must use session readInboxDigest");
}

const idKey = lib.stableIdempotencyKey({
  sessionId: "s1",
  context: "abc",
  mode: "compiler",
  query: "do the thing",
});
if (!/^[a-f0-9]{40}$/.test(idKey)) throw new Error("bad stable idempotency key: " + idKey);
const idKey2 = lib.stableIdempotencyKey({
  sessionId: "s1",
  context: "abc",
  mode: "compiler",
  query: "different task",
});
if (idKey === idKey2) throw new Error("stable idempotency key must include query");
if (lib.resolveSessionId({ fallback: "none" }) != null) {
  throw new Error("fallback=none must return null without session id");
}
if (!String(lib.resolveSessionId({ fallback: "ephemeral" }) || "").startsWith("ephemeral_")) {
  throw new Error("fallback=ephemeral must mint ephemeral session id");
}
if (!/1_200_000|1200000/.test(pluginAsset) && /180000/.test(pluginAsset)) {
  throw new Error("OpenClaw plugin still hard-clips at 180k before chunker");
}
if (!/no OpenClaw session/.test(pluginAsset)) {
  throw new Error("OpenClaw plugin must refuse cwd fallback when session id missing");
}

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
