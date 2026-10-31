#!/usr/bin/env node
/**
 * `supercompress uninstall` must remove only what SuperCompress added.
 *
 * Regression: uninstall rewound every backed-up config whose install-time
 * snapshot was not a JSON file with an `mcpServers`/`mcp` key — Codex and
 * Grok Build `config.toml`, Gemini/Zed/Continue/Goose/Hermes configs, and any
 * file setup created (those were deleted outright). MCP servers and settings
 * the user added after installing SuperCompress were wiped.
 *
 * Each case: write a starting config, `plugin` (install), add another MCP
 * server the way a user would, `uninstall`, then assert the user's server
 * survives byte-for-byte and SuperCompress is gone.
 *
 * Every command runs against a throwaway HOME.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "bin", "supercompress.js");

function env(home) {
  const e = { ...process.env, HOME: home, USERPROFILE: home, SHELL: "/bin/bash" };
  delete e.SUPERCOMPRESS_CONFIG_DIR;
  delete e.GROK_HOME;
  delete e.FX_HOME;
  return e;
}

function run(home, ...args) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 60000,
    env: env(home),
  });
  assert.strictEqual(res.status, 0, `${args.join(" ")} exited ${res.status}: ${res.stderr}`);
  return res;
}

/** Run detector calls in a child process bound to `home`. */
function detector(home, code) {
  const script = `const d = require(${JSON.stringify(path.join(ROOT, "src", "detector.js"))});\n${code}`;
  const res = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 60000, env: env(home) });
  assert.strictEqual(res.status, 0, `detector script failed: ${res.stderr}`);
  return res;
}

function newHome(dirs = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sc-keep-user-"));
  for (const d of dirs) fs.mkdirSync(path.join(home, d), { recursive: true });
  return home;
}

function write(home, rel, content) {
  const p = path.join(home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

const read = (p) => fs.readFileSync(p, "utf8");
let passed = 0;
function ok(msg) {
  console.log(`✔ ${msg}`);
  passed += 1;
}

// 1. Codex config.toml — a server added after install survives, and the file
//    returns byte-for-byte to "original + the user's addition".
{
  const home = newHome([".codex"]);
  const original =
    '# my codex config\nmodel = "o3"\n\n[mcp_servers.github]\ncommand = "gh-mcp" # inline note\nargs = ["--stdio"]\n';
  const cfg = write(home, ".codex/config.toml", original);

  run(home, "plugin");
  assert.match(read(cfg), /\[mcp_servers\.supercompress\]/, "precondition: Codex MCP installed");

  const added = '\n# added later by me\n[mcp_servers.linear]\ncommand = "linear-mcp"\n\n[mcp_servers.linear.env]\nLINEAR_TOKEN = "x"\n';
  fs.appendFileSync(cfg, added);

  run(home, "uninstall");
  const after = read(cfg);
  assert.ok(!/supercompress/i.test(after), `Codex config still mentions SuperCompress:\n${after}`);
  assert.match(after, /\[mcp_servers\.linear\]/, "Codex MCP server added after install must survive uninstall");
  assert.match(after, /LINEAR_TOKEN = "x"/, "its env sub-table must survive too");
  assert.match(after, /# added later by me/, "the user's comment must survive");
  assert.strictEqual(after, `${original}${added}`, "Codex config must be original + user additions, byte-for-byte");
  fs.rmSync(home, { recursive: true, force: true });
  ok("Codex: MCP server added after install survives uninstall (byte-for-byte)");
}

// 2. Grok Build config.toml — user server survives; the [mcp] output cap
//    setup raised goes back to the user's original value.
{
  const home = newHome([".grok"]);
  const original = '# grok\n[mcp]\nmax_output_bytes = 50000\n\n[mcp_servers.fs]\ncommand = "fs-mcp"\nenabled = true\n';
  const cfg = write(home, ".grok/config.toml", original);

  run(home, "plugin");
  const installed = read(cfg);
  assert.match(installed, /\[mcp_servers\.supercompress\]/, "precondition: Grok MCP installed");
  assert.match(installed, /max_output_bytes = 2000000/, "precondition: Grok output cap raised");

  const added = '\n[mcp_servers.late]\ncommand = "late-mcp"\nenv = { A = "1" }\n';
  fs.appendFileSync(cfg, added);

  run(home, "uninstall");
  const after = read(cfg);
  assert.ok(!/supercompress/i.test(after), `Grok config still mentions SuperCompress:\n${after}`);
  assert.match(after, /\[mcp_servers\.late\]/, "Grok MCP server added after install must survive uninstall");
  assert.match(after, /max_output_bytes = 50000/, "the original max_output_bytes must be restored");
  assert.strictEqual(after, `${original}${added}`, "Grok config must be original + user additions, byte-for-byte");
  fs.rmSync(home, { recursive: true, force: true });
  ok("Grok Build: MCP server added after install survives; original output cap restored");
}

// 3. Grok Build config.toml created by setup — uninstall must not delete it
//    once the user has added their own server; our [mcp] cap goes away.
{
  const home = newHome([".grok"]);
  const cfg = path.join(home, ".grok", "config.toml");
  run(home, "plugin");
  assert.ok(fs.existsSync(cfg), "precondition: setup created Grok config.toml");
  fs.appendFileSync(cfg, '\n[mcp_servers.mine]\ncommand = "mine-mcp"\n');

  run(home, "uninstall");
  assert.ok(fs.existsSync(cfg), "a config setup created must not be deleted once the user added to it");
  const after = read(cfg);
  assert.ok(!/supercompress/i.test(after), `still mentions SuperCompress:\n${after}`);
  assert.ok(!/max_output_bytes/.test(after), "the output cap setup introduced must be removed");
  assert.strictEqual(after, '[mcp_servers.mine]\ncommand = "mine-mcp"\n');
  fs.rmSync(home, { recursive: true, force: true });
  ok("Grok Build: setup-created config keeps the user's later server");
}

// 4. JSON MCP hosts: Cursor (file created by setup), Gemini CLI (settings
//    without mcpServers at install), Claude Code (custom formatting).
{
  const home = newHome([".cursor", ".gemini", ".claude"]);
  const gemini = write(home, ".gemini/settings.json", '{\n  "theme": "dark"\n}\n');
  const claudeJsonOriginal =
    '{\n    "numStartups": 3,\n    "mcpServers": {\n        "existing": {"command": "uvx", "args": ["a"]}\n    }\n}\n';
  const claudeJson = write(home, ".claude.json", claudeJsonOriginal);
  const cursor = path.join(home, ".cursor", "mcp.json");

  run(home, "plugin");
  for (const p of [cursor, gemini, claudeJson]) {
    assert.ok(JSON.parse(read(p)).mcpServers.supercompress, `precondition: ${p} has SuperCompress`);
  }
  const addServer = (p, name) => {
    const data = JSON.parse(read(p));
    data.mcpServers[name] = { command: `${name}-mcp`, args: [] };
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
  };
  addServer(cursor, "cursorlater");
  addServer(gemini, "geminilater");
  // Edit ~/.claude.json by hand, keeping its 4-space style.
  const claudeInstalled = read(claudeJson);
  const claudeEdited = claudeInstalled.replace(
    /"mcpServers": \{/,
    '"mcpServers": {\n    "claudelater": { "command": "later-mcp" },'
  );
  assert.notStrictEqual(claudeEdited, claudeInstalled, "fixture edit applied");
  fs.writeFileSync(claudeJson, claudeEdited);

  run(home, "uninstall");
  assert.ok(fs.existsSync(cursor), "Cursor mcp.json created by setup must not be deleted once the user added a server");
  assert.deepStrictEqual(Object.keys(JSON.parse(read(cursor)).mcpServers), ["cursorlater"]);
  const g = JSON.parse(read(gemini));
  assert.deepStrictEqual(Object.keys(g.mcpServers), ["geminilater"], "Gemini server added after install must survive");
  assert.strictEqual(g.theme, "dark");
  assert.strictEqual(g.supercompress, undefined, "Gemini flag must be removed");
  const c = read(claudeJson);
  assert.ok(!/supercompress/i.test(c), c);
  assert.ok(JSON.parse(c).mcpServers.claudelater, "Claude Code server added after install must survive");
  assert.ok(JSON.parse(c).mcpServers.existing, "pre-existing Claude Code server must survive");
  fs.rmSync(home, { recursive: true, force: true });
  ok("Cursor / Gemini CLI / Claude Code: MCP servers added after install survive");
}

// 5. Byte-level preservation for JSONC (Zed) and an untouched sibling layout.
{
  const home = newHome([".config/zed"]);
  const zed = write(
    home,
    ".config/zed/settings.json",
    '// Zed settings\n{\n  "theme": "One Dark",\n  "context_servers": {\n    "other": { "command": "other-mcp", "args": [] }\n  }\n}\n'
  );
  run(home, "plugin");
  const installed = JSON.parse(read(zed));
  assert.ok(installed.context_servers.supercompress, "precondition: Zed configured");
  assert.strictEqual(installed.agent.enable_all_context_servers, true);

  // User adds a server with a comment after install.
  const withUser = read(zed).replace(
    /"context_servers": \{/,
    '"context_servers": {\n    // my new server\n    "zedlater": { "command": "zed-later" },'
  );
  fs.writeFileSync(zed, withUser);

  run(home, "uninstall");
  const after = read(zed);
  assert.ok(!/supercompress/i.test(after), after);
  assert.match(after, /\/\/ my new server/, "comments the user added must survive");
  assert.match(after, /"zedlater"/, "Zed server added after install must survive");
  assert.match(after, /"other"/, "pre-existing Zed server must survive");
  assert.ok(!/enable_all_context_servers/.test(after), "agent default setup introduced must be removed");
  fs.rmSync(home, { recursive: true, force: true });
  ok("Zed: user server + comments survive; setup-introduced defaults removed");
}

// 6. OpenCode, Continue, Goose, Hermes, OpenClaw.
{
  const home = newHome([".config/opencode", ".continue", ".config/goose", ".hermes", ".openclaw"]);
  const opencode = write(home, ".config/opencode/opencode.json", '{\n  "theme": "x"\n}\n');
  const cont = write(home, ".continue/config.json", '{\n  "models": []\n}\n');
  const goose = write(home, ".config/goose/config.yaml", "GOOSE_MODEL: gpt-4o\n");
  const hermes = write(home, ".hermes/config.yaml", "model: x\n");
  const openclaw = write(home, ".openclaw/openclaw.json", '{\n  "agent": "main"\n}\n');

  run(home, "plugin");

  let d = JSON.parse(read(opencode));
  d.mcp.later = { type: "local", command: ["later"], enabled: true };
  fs.writeFileSync(opencode, JSON.stringify(d, null, 2) + "\n");

  d = JSON.parse(read(cont));
  d.experimental.modelContextProtocolServers.push({ transport: { type: "stdio", command: "cont-later", args: [] } });
  fs.writeFileSync(cont, JSON.stringify(d, null, 2) + "\n");

  const gooseInstalled = read(goose);
  assert.match(gooseInstalled, /^ {2}supercompress:/m, "precondition: Goose configured");
  fs.writeFileSync(goose, gooseInstalled.replace(/^extensions:\n/m, "extensions:\n  developer:\n    enabled: true\n    type: builtin\n"));

  const hermesInstalled = read(hermes);
  assert.match(hermesInstalled, /^mcp_servers:/m, "precondition: Hermes configured");
  fs.writeFileSync(hermes, hermesInstalled.replace(/^mcp_servers:\n/m, "mcp_servers:\n  hermeslater:\n    command: later\n"));

  d = JSON.parse(read(openclaw));
  d.mcp.servers.clawlater = { command: "claw-later" };
  fs.writeFileSync(openclaw, JSON.stringify(d, null, 2) + "\n");

  run(home, "uninstall");

  const oc = JSON.parse(read(opencode));
  assert.deepStrictEqual(Object.keys(oc.mcp), ["later"], "OpenCode server added after install must survive");
  assert.strictEqual(oc.experimental, undefined, "OpenCode mcp_timeout default setup introduced must be removed");
  const co = JSON.parse(read(cont));
  assert.deepStrictEqual(
    co.experimental.modelContextProtocolServers.map((s) => s.transport.command),
    ["cont-later"],
    "Continue server added after install must survive"
  );
  const go = read(goose);
  assert.ok(!/supercompress/i.test(go), go);
  assert.match(go, /developer:\n {4}enabled: true/, "Goose extension added after install must survive");
  const he = read(hermes);
  assert.ok(!/supercompress/i.test(he), he);
  assert.match(he, /hermeslater:\n {4}command: later/, "Hermes server added after install must survive");
  const cl = JSON.parse(read(openclaw));
  assert.deepStrictEqual(Object.keys(cl.mcp.servers), ["clawlater"], "OpenClaw server added after install must survive");
  assert.strictEqual(cl.agent, "main");
  fs.rmSync(home, { recursive: true, force: true });
  ok("OpenCode / Continue / Goose / Hermes / OpenClaw: servers added after install survive");
}

// 7. Proxy-mode settings: restore only the keys setup overwrote, keep later
//    user edits, and never touch a value the user changed themselves.
{
  const home = newHome([".claude", ".codex", ".cursor"]);
  const settings = write(home, ".claude/settings.json", '{"env":{"ANTHROPIC_BASE_URL":"https://gw.example"}}');
  const codex = write(home, ".codex/config.toml", 'openai_base_url = "https://my.proxy/v1"\nmodel = "o3"\n');
  const cursorCfg = write(home, ".cursor/config.json", '{"openAiBaseUrl":"https://mine/v1","theme":"dark"}');
  const bashrc = write(home, ".bashrc", "export ANTHROPIC_BASE_URL=https://gw.example\nalias ll='ls -l'\n");

  detector(home, "d.configureAll(); d.configureMcp();");
  assert.match(read(codex), /openai_base_url = "http:\/\/localhost:8080\/v1"/, "precondition: Codex proxied");
  assert.match(read(bashrc), /ANTHROPIC_BASE_URL=http:\/\/localhost:8080/, "precondition: profile proxied");

  // User edits after install.
  const s = JSON.parse(read(settings));
  s.model = "opus";
  fs.writeFileSync(settings, JSON.stringify(s, null, 2));
  fs.appendFileSync(codex, '\n[mcp_servers.after]\ncommand = "after-mcp"\n');
  const cc = JSON.parse(read(cursorCfg));
  cc.fontSize = 14;
  fs.writeFileSync(cursorCfg, JSON.stringify(cc, null, 2));
  fs.appendFileSync(bashrc, "export EDITOR=vim\n");

  run(home, "uninstall");
  const s2 = JSON.parse(read(settings));
  assert.strictEqual(s2.env.ANTHROPIC_BASE_URL, "https://gw.example", "original ANTHROPIC_BASE_URL must be restored");
  assert.strictEqual(s2.model, "opus", "settings added after install must survive");
  const codexAfter = read(codex);
  assert.match(codexAfter, /^openai_base_url = "https:\/\/my\.proxy\/v1"$/m, "original Codex base URL must be restored");
  assert.match(codexAfter, /\[mcp_servers\.after\]/, "Codex server added after install must survive");
  assert.ok(!/supercompress|localhost:8080/i.test(codexAfter), codexAfter);
  const cc2 = JSON.parse(read(cursorCfg));
  assert.strictEqual(cc2.openAiBaseUrl, "https://mine/v1", "original Cursor base URL must be restored");
  assert.strictEqual(cc2.fontSize, 14, "Cursor settings added after install must survive");
  const rc = read(bashrc);
  assert.match(rc, /^export ANTHROPIC_BASE_URL=https:\/\/gw\.example$/m, "original profile export must be restored");
  assert.match(rc, /^export EDITOR=vim$/m, "profile lines added after install must survive");
  assert.ok(!/localhost:8080|SuperCompress/.test(rc), rc);
  fs.rmSync(home, { recursive: true, force: true });
  ok("Proxy settings: only overwritten keys restored, later user edits kept");
}

// 8. Missing / malformed configs: uninstall must not crash or wipe them.
{
  const home = newHome([".cursor", ".codex", ".gemini"]);
  run(home, "plugin");
  const cursor = path.join(home, ".cursor", "mcp.json");
  const gemini = path.join(home, ".gemini", "settings.json");
  const broken = '{ "mcpServers": { "supercompress": {}, "mine": { "command": "x" } '; // truncated
  fs.writeFileSync(cursor, broken);
  fs.writeFileSync(gemini, "not json at all\n");
  fs.rmSync(path.join(home, ".codex", "config.toml"), { force: true });

  const res = run(home, "uninstall");
  assert.strictEqual(read(cursor), broken, "a malformed config must be left exactly as it was");
  assert.strictEqual(read(gemini), "not json at all\n", "a malformed config must be left exactly as it was");
  assert.ok(!fs.existsSync(path.join(home, ".codex", "config.toml")), "a missing config must not be recreated");
  assert.match(res.stdout, /uninstalled/);
  fs.rmSync(home, { recursive: true, force: true });
  ok("Malformed / missing configs: no crash, no wipe");
}

console.log(`\nuninstall-preserves-user-config: ${passed} checks passed`);
