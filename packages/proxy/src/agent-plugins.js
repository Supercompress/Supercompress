/**
 * Pluggable coding-agent MCP adapters.
 *
 * Built-ins: Hermes (~/.hermes/config.yaml mcp_servers),
 *            OpenClaw (~/.openclaw/openclaw.json mcp.servers),
 *            plus Cursor-style mcp-json / OpenCode / Codex formats for custom agents.
 *
 * Custom plugins: ~/.supercompress/agent-plugins.json
 *   and/or       ~/.supercompress/plugins/<id>.json
 *
 * Schema (one plugin):
 * {
 *   "id": "my-agent",
 *   "name": "My Agent",
 *   "format": "mcp-json" | "hermes-yaml" | "openclaw-json" | "opencode-json" | "codex-toml" | "instruction-only",
 *   "configPath": "~/.myagent/mcp.json",
 *   "detectCommands": ["myagent"],
 *   "detectDirs": [".myagent"],
 *   "instructionPath": "~/.myagent/AGENTS.md",
 *   "enabled": true
 * }
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const HOME = os.homedir();
const CONFIG_DIR = process.env.SUPERCOMPRESS_CONFIG_DIR || path.join(HOME, ".supercompress");
const MCP_SERVER_PATH = path.join(__dirname, "mcp.js");
const PLUGINS_FILE = path.join(CONFIG_DIR, "agent-plugins.json");
const PLUGINS_DIR = path.join(CONFIG_DIR, "plugins");

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}

function commandExists(cmd) {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function resolveMcpLaunch({ preferAbsolute = true } = {}) {
  // Prefer absolute node+mcp.js — agent hosts often lack npm global bins on PATH.
  if (!preferAbsolute && commandExists("supercompress-mcp")) {
    return { command: "supercompress-mcp", args: [] };
  }
  if (!preferAbsolute) {
    // Still fall through to absolute when shim missing
    if (commandExists("supercompress-mcp")) {
      return { command: "supercompress-mcp", args: [] };
    }
  }
  return { command: process.execPath, args: [MCP_SERVER_PATH] };
}

function mcpEnv() {
  return { SUPERCOMPRESS_CONFIG_DIR: CONFIG_DIR };
}

function mcpStdioEntry(opts = {}) {
  const launch = resolveMcpLaunch(opts);
  return {
    command: launch.command,
    args: launch.args,
    env: mcpEnv(),
  };
}

/** Strip line/block comments and trailing commas for JSON5-ish configs. */
function parseLooseJson(text) {
  let out = "";
  let i = 0;
  let inString = false;
  let quote = "";
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) inString = false;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  // trailing commas before } or ]
  out = out.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(out);
}

function yamlQuote(s) {
  const str = String(s ?? "");
  if (/^[\w./:@+-]+$/.test(str) && !/^(true|false|null|yes|no)$/i.test(str)) return str;
  return JSON.stringify(str);
}

/** Stable marker for SuperCompress instruction blocks (idempotent upsert). */
const INSTRUCTION_MARKER = "# SuperCompress (always on · Headroom-parity)";

function stripSupercompressInstructionBlocks(text) {
  return String(text || "")
    .replace(
      /(?:^|\n)# SuperCompress \(always on[^\n]*\)[\s\S]*?(?=\n# (?!SuperCompress)|\n## |$)/g,
      "\n"
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderHermesSupercompressBlock(indent = "  ") {
  // Always absolute node+mcp for Hermes — gateway PATH often lacks npm bins
  const entry = mcpStdioEntry({ preferAbsolute: true });
  const lines = [
    `${indent}supercompress:`,
    `${indent}  command: ${yamlQuote(entry.command)}`,
  ];
  if (entry.args.length) {
    lines.push(`${indent}  args:`);
    for (const a of entry.args) lines.push(`${indent}    - ${yamlQuote(a)}`);
  } else {
    lines.push(`${indent}  args: []`);
  }
  lines.push(`${indent}  env:`);
  for (const [k, v] of Object.entries(entry.env)) {
    lines.push(`${indent}    ${k}: ${yamlQuote(v)}`);
  }
  lines.push(`${indent}  enabled: true`);
  lines.push(`${indent}  timeout: 120`);
  lines.push(`${indent}  connect_timeout: 60`);
  return lines.join("\n");
}

/**
 * Upsert mcp_servers.supercompress in a Hermes-style YAML file without a YAML lib.
 */
function writeHermesYaml(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const block = renderHermesSupercompressBlock("  ");
  let raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";

  // Remove existing supercompress entry under mcp_servers (best-effort)
  raw = raw.replace(
    /(^|\n)([ \t]*)supercompress:[ \t]*\n(?:\2[ \t]+[^\n]*\n)*/g,
    "$1"
  );

  if (/^mcp_servers:[ \t]*$/m.test(raw) || /^mcp_servers:[ \t]*\n/m.test(raw)) {
    raw = raw.replace(/^(mcp_servers:[ \t]*\n)/m, `$1${block}\n`);
  } else if (/^mcp_servers:[ \t]*\{\s*\}/m.test(raw)) {
    raw = raw.replace(/^mcp_servers:[ \t]*\{\s*\}/m, `mcp_servers:\n${block}`);
  } else {
    raw = `${raw.trimEnd()}\n\nmcp_servers:\n${block}\n`;
  }

  fs.writeFileSync(filePath, raw.endsWith("\n") ? raw : `${raw}\n`);
}

function removeHermesYaml(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const before = fs.readFileSync(filePath, "utf8");
  const after = before.replace(
    /(^|\n)([ \t]*)supercompress:[ \t]*\n(?:\2[ \t]+[^\n]*\n)*/g,
    "$1"
  );
  if (after === before) return false;
  fs.writeFileSync(filePath, after);
  return true;
}

function writeOpenClawJson(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let data = {};
  if (fs.existsSync(filePath)) {
    try {
      data = parseLooseJson(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
      throw new Error(`OpenClaw config is not valid JSON/JSON5 (${filePath}): ${err.message}`);
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`OpenClaw config must be a JSON object (${filePath})`);
  }
  data.mcp = data.mcp && typeof data.mcp === "object" ? data.mcp : {};
  data.mcp.servers = data.mcp.servers && typeof data.mcp.servers === "object" ? data.mcp.servers : {};
  const entry = mcpStdioEntry();
  data.mcp.servers.supercompress = {
    command: entry.command,
    args: entry.args,
    env: entry.env,
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function removeOpenClawJson(filePath) {
  if (!fs.existsSync(filePath)) return false;
  let data;
  try {
    data = parseLooseJson(fs.readFileSync(filePath, "utf8"));
  } catch {
    return false;
  }
  if (!data?.mcp?.servers?.supercompress) return false;
  delete data.mcp.servers.supercompress;
  if (data.mcp.servers && Object.keys(data.mcp.servers).length === 0) delete data.mcp.servers;
  if (data.mcp && Object.keys(data.mcp).length === 0) delete data.mcp;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
  return true;
}

function writeMcpJson(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let data = {};
  if (fs.existsSync(filePath)) {
    data = parseLooseJson(fs.readFileSync(filePath, "utf8"));
  }
  data.mcpServers = data.mcpServers || {};
  const entry = mcpStdioEntry();
  data.mcpServers.supercompress = {
    command: entry.command,
    args: entry.args,
    env: entry.env,
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function removeMcpJson(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const data = parseLooseJson(fs.readFileSync(filePath, "utf8"));
  if (!data.mcpServers?.supercompress) return false;
  delete data.mcpServers.supercompress;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
  return true;
}

function writeOpenCodeJson(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let data = {};
  if (fs.existsSync(filePath)) {
    data = parseLooseJson(fs.readFileSync(filePath, "utf8"));
  }
  data.mcp = data.mcp || {};
  const launch = resolveMcpLaunch();
  data.mcp.supercompress = {
    type: "local",
    command: launch.args.length ? [launch.command, ...launch.args] : [launch.command],
    enabled: true,
    timeout: 60000,
    environment: mcpEnv(),
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function removeOpenCodeJson(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const data = parseLooseJson(fs.readFileSync(filePath, "utf8"));
  if (!data.mcp?.supercompress) return false;
  delete data.mcp.supercompress;
  if (data.mcp && Object.keys(data.mcp).length === 0) delete data.mcp;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
  return true;
}

function writeCodexToml(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const entry = mcpStdioEntry();
  let raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const block =
    `[mcp_servers.supercompress]\n` +
    `command = ${JSON.stringify(entry.command)}\n` +
    `args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]\n` +
    `[mcp_servers.supercompress.env]\n` +
    `SUPERCOMPRESS_CONFIG_DIR = ${JSON.stringify(CONFIG_DIR)}\n`;
  raw = raw
    .replace(/\n?\[mcp_servers\.supercompress\.env\][\s\S]*?(?=\n\[|$)/, "\n")
    .replace(/\n?\[mcp_servers\.supercompress\][\s\S]*?(?=\n\[|$)/, "\n");
  raw = `${raw.trimEnd()}\n\n${block}`;
  fs.writeFileSync(filePath, raw.startsWith("\n") ? raw.slice(1) : raw);
}

function removeCodexToml(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const raw = fs.readFileSync(filePath, "utf8");
  const cleaned = raw
    .replace(/\n?\[mcp_servers\.supercompress\.env\][\s\S]*?(?=\n\[|$)/, "\n")
    .replace(/\n?\[mcp_servers\.supercompress\][\s\S]*?(?=\n\[|$)/, "\n");
  if (cleaned === raw) return false;
  fs.writeFileSync(filePath, cleaned.trimEnd() + "\n");
  return true;
}

const FORMAT_WRITERS = {
  "mcp-json": { write: writeMcpJson, remove: removeMcpJson },
  "hermes-yaml": { write: writeHermesYaml, remove: removeHermesYaml },
  "openclaw-json": { write: writeOpenClawJson, remove: removeOpenClawJson },
  "opencode-json": { write: writeOpenCodeJson, remove: removeOpenCodeJson },
  "codex-toml": { write: writeCodexToml, remove: removeCodexToml },
  "instruction-only": { write: () => {}, remove: () => false },
};

const BUILTIN_PLUGINS = [
  {
    id: "hermes",
    name: "Hermes",
    format: "hermes-yaml",
    configPath: path.join(HOME, ".hermes", "config.yaml"),
    detectCommands: ["hermes"],
    detectDirs: [".hermes"],
    instructionPath: path.join(HOME, ".hermes", "AGENTS.md"),
    builtin: true,
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    format: "openclaw-json",
    configPath: path.join(HOME, ".openclaw", "openclaw.json"),
    detectCommands: ["openclaw", "claw"],
    detectDirs: [".openclaw"],
    instructionPath: path.join(HOME, ".openclaw", "AGENTS.md"),
    // Also wire mcporter registry when present (OpenClaw skill path)
    extraWriters: [
      {
        format: "mcp-json",
        configPath: path.join(HOME, ".mcporter", "mcporter.json"),
        detectDirs: [".mcporter"],
      },
    ],
    builtin: true,
  },
];

function normalizePlugin(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || raw.name || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w.-]+/g, "-");
  if (!id) return null;
  const format = String(raw.format || "mcp-json").trim();
  if (!FORMAT_WRITERS[format]) {
    throw new Error(`Unknown plugin format "${format}" for ${id}. Valid: ${Object.keys(FORMAT_WRITERS).join(", ")}`);
  }

  let configPath = expandHome(raw.configPath || raw.config_path || "");
  if (!configPath) {
    const defaults = {
      "mcp-json": path.join(HOME, `.${id}`, "mcp.json"),
      "hermes-yaml": path.join(HOME, `.${id}`, "config.yaml"),
      "openclaw-json": path.join(HOME, `.${id}`, `${id}.json`),
      "opencode-json": path.join(HOME, ".config", id, "opencode.json"),
      "codex-toml": path.join(HOME, `.${id}`, "config.toml"),
      "instruction-only": "",
    };
    configPath = defaults[format] || path.join(HOME, `.${id}`, "mcp.json");
  }

  let instructionPath = expandHome(raw.instructionPath || raw.instruction_path || "");
  if (!instructionPath && configPath) {
    instructionPath = path.join(path.dirname(configPath), "AGENTS.md");
  } else if (!instructionPath) {
    instructionPath = path.join(HOME, `.${id}`, "AGENTS.md");
  }

  let detectDirs = Array.isArray(raw.detectDirs || raw.detect_dirs)
    ? (raw.detectDirs || raw.detect_dirs).map((d) => String(d).replace(/^\~\//, ""))
    : [];
  if (!detectDirs.length && configPath) {
    const rel = path.relative(HOME, path.dirname(configPath));
    if (rel && !rel.startsWith("..")) detectDirs = [rel];
  }

  return {
    id,
    name: String(raw.name || id),
    format,
    configPath,
    detectCommands: Array.isArray(raw.detectCommands || raw.detect_commands)
      ? raw.detectCommands || raw.detect_commands
      : [],
    detectDirs,
    instructionPath,
    enabled: raw.enabled !== false,
    builtin: Boolean(raw.builtin),
    // Registered customs are always eligible for install (user opted in)
    alwaysInstall: raw.alwaysInstall !== false && !raw.builtin,
    wrapBin: raw.wrapBin || raw.wrap_bin || (Array.isArray(raw.detectCommands) && raw.detectCommands[0]) || null,
    extraWriters: Array.isArray(raw.extraWriters) ? raw.extraWriters : [],
  };
}

function loadCustomPluginFile(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Array.isArray(data.plugins)) return data.plugins.map(normalizePlugin).filter(Boolean);
    if (data.id || data.name) {
      const one = normalizePlugin(data);
      return one ? [one] : [];
    }
  } catch (err) {
    console.error(`  ⚠ Bad plugin file ${filePath}: ${err.message}`);
  }
  return [];
}

function loadRegistryPlugins() {
  if (!fs.existsSync(PLUGINS_FILE)) return [];
  return loadCustomPluginFile(PLUGINS_FILE);
}

function loadDropInPlugins() {
  const out = [];
  if (!fs.existsSync(PLUGINS_DIR)) return out;
  for (const name of fs.readdirSync(PLUGINS_DIR)) {
    if (!name.endsWith(".json")) continue;
    // Skip the disabled scaffold example unless someone enables it
    if (name === "example.custom-agent.json") {
      const parsed = loadCustomPluginFile(path.join(PLUGINS_DIR, name));
      out.push(...parsed.filter((p) => p.enabled !== false));
      continue;
    }
    out.push(...loadCustomPluginFile(path.join(PLUGINS_DIR, name)));
  }
  return out;
}

function loadCustomPlugins() {
  const out = [];
  const seen = new Set();
  for (const p of [...loadRegistryPlugins(), ...loadDropInPlugins()]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

function allPlugins() {
  const customs = loadCustomPlugins();
  const customIds = new Set(customs.map((p) => p.id));
  // Custom can override builtin by same id
  const builtins = BUILTIN_PLUGINS.map(normalizePlugin).filter((p) => p && !customIds.has(p.id));
  return [...builtins, ...customs].filter((p) => p.enabled !== false);
}

function instructionBody() {
  const inboxPath = path.join(HOME, ".supercompress", "inbox", "latest.md");
  return [
    INSTRUCTION_MARKER,
    "",
    "**Auto (Headroom-parity):** compress every *new* bulky context dump; when rolling session memory gets large, compact it. Never compress the user's ask/query. Skip already-seen chunks.",
    "",
    "What to compress: tool dumps, file reads, logs, diffs, pasted blobs, scrapes, long history — anything that is not the current user question.",
    "",
    "1. If `" + inboxPath + "` exists, Read it first — session digest (ask is unchanged).",
    "2. Else call MCP `compress_context` with `context`=<new dump only> and `query`=<user ask>. Prefer the returned digest.",
    "3. Hooks also auto-compress on submit + after large tool results when installed.",
    "4. If compress_context fails with account-not-linked, call `connect_account` once, then retry.",
    "",
  ].join("\n");
}

function writeInstructionFile(filePath) {
  if (!filePath) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = instructionBody();
  let next = body;
  if (fs.existsSync(filePath)) {
    const prev = fs.readFileSync(filePath, "utf8");
    const stripped = stripSupercompressInstructionBlocks(prev);
    next = stripped ? `${stripped}\n\n${body}` : body;
  }
  fs.writeFileSync(filePath, next.endsWith("\n") ? next : `${next}\n`);
  return true;
}

/**
 * Wire Hermes: MCP + shell hooks (pre_llm / post_tool) + transform plugin +
 * native compression enabled with proactive tool-result prune.
 */
function writeHermesAutoCompress(hermesHome = path.join(HOME, ".hermes")) {
  const installed = [];
  fs.mkdirSync(hermesHome, { recursive: true });
  const configPath = path.join(hermesHome, "config.yaml");
  writeHermesYaml(configPath);
  installed.push("mcp");

  const instructionPath = path.join(hermesHome, "AGENTS.md");
  writeInstructionFile(instructionPath);
  installed.push("AGENTS.md");

  const hooksSrc = path.join(__dirname, "hermes-hooks");
  const hooksDest = path.join(hermesHome, "agent-hooks", "supercompress");
  fs.mkdirSync(hooksDest, { recursive: true });
  for (const name of [
    "pre-llm-call.js",
    "post-tool-call.js",
    "transform-tool-result.js",
  ]) {
    const src = path.join(hooksSrc, name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(hooksDest, name);
    fs.copyFileSync(src, dest);
    try {
      fs.chmodSync(dest, 0o755);
    } catch {}
  }
  // Shared session-memory lib (also used by Cursor hooks)
  const libSrc = path.join(__dirname, "cursor-hooks", "compress-prompt-lib.js");
  if (fs.existsSync(libSrc)) {
    fs.copyFileSync(libSrc, path.join(hooksDest, "compress-prompt-lib.js"));
  }
  installed.push("agent-hooks");

  const pluginDest = path.join(hermesHome, "plugins", "supercompress");
  const pluginSrc = path.join(hooksSrc, "plugin");
  const pluginYaml = path.join(pluginSrc, "plugin.yaml");
  const pluginInit = path.join(pluginSrc, "__init__.py");
  if (fs.existsSync(pluginYaml) && fs.existsSync(pluginInit)) {
    fs.mkdirSync(pluginDest, { recursive: true });
    fs.copyFileSync(pluginYaml, path.join(pluginDest, "plugin.yaml"));
    fs.copyFileSync(pluginInit, path.join(pluginDest, "__init__.py"));
    const transformSrc = path.join(hooksDest, "transform-tool-result.js");
    if (fs.existsSync(transformSrc)) {
      fs.copyFileSync(transformSrc, path.join(pluginDest, "transform-tool-result.js"));
    }
    if (fs.existsSync(path.join(hooksDest, "compress-prompt-lib.js"))) {
      fs.copyFileSync(
        path.join(hooksDest, "compress-prompt-lib.js"),
        path.join(pluginDest, "compress-prompt-lib.js")
      );
    }
    installed.push("plugin:transform_tool_result");
  }

  const nodeBin = process.execPath;
  const preCmd = yamlQuote(`${nodeBin} ${path.join(hooksDest, "pre-llm-call.js")}`);
  const postCmd = yamlQuote(`${nodeBin} ${path.join(hooksDest, "post-tool-call.js")}`);

  let raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";

  // Drop previous SuperCompress auto block(s)
  raw = raw.replace(/\n?# supercompress-auto[\s\S]*?(?=\n# [^\n]+|\n[a-z_][a-z0-9_]*:|\n*$)/g, "\n");
  // Drop any hook command lines pointing at our scripts
  raw = raw.replace(
    /(^|\n)([ \t]*)-[ \t]*command:[^\n]*(?:pre-llm-call|post-tool-call|agent-hooks\/supercompress)[^\n]*\n(?:\2[ \t]+[^\n]*\n)*/g,
    "$1"
  );

  if (!/^hooks_auto_accept:/m.test(raw)) {
    raw = `${raw.trimEnd()}\n\nhooks_auto_accept: true\n`;
  } else {
    raw = raw.replace(/^hooks_auto_accept:[^\n]*/m, "hooks_auto_accept: true");
  }

  // Native Hermes conversation compact + proactive tool-result prune
  if (!/^compression:/m.test(raw)) {
    raw = `${raw.trimEnd()}\n
compression:
  enabled: true
  threshold: 0.50
  target_ratio: 0.20
  protect_last_n: 20
  in_place: true
  proactive_prune_tokens: 48000
  proactive_prune_min_result_chars: 4000
`;
  } else if (!/proactive_prune_tokens:/m.test(raw)) {
    raw = raw.replace(
      /^compression:[ \t]*\n/m,
      "compression:\n  proactive_prune_tokens: 48000\n  proactive_prune_min_result_chars: 4000\n"
    );
  }

  // Ensure hooks: mapping exists, then upsert our two entries
  if (!/^hooks:/m.test(raw)) {
    raw = `${raw.trimEnd()}\n\nhooks: {}\n`;
  }

  const hooksBlock = `
# supercompress-auto — new context every turn + compact when big
hooks:
  pre_llm_call:
    - command: ${preCmd}
      timeout: 25
  post_tool_call:
    - command: ${postCmd}
      timeout: 25
`;

  // Replace entire hooks: key with our merged block (preserve non-SC hooks if any remain above)
  // Prefer single authoritative SC hooks block at end.
  raw = raw.replace(/^hooks:[ \t]*\{[ \t]*\}[ \t]*\n?/m, "");
  raw = raw.replace(/^hooks:[ \t]*\n(?:(?:[ \t]+[^\n]*\n)+)/m, (block) => {
    // Keep unrelated hook events that don't mention supercompress
    if (!/supercompress|pre-llm-call|post-tool-call/.test(block)) return block;
    return "";
  });
  raw = `${raw.trimEnd()}\n${hooksBlock}\n`;
  fs.writeFileSync(configPath, raw.endsWith("\n") ? raw : `${raw}\n`);
  installed.push("hooks+compression");

  // Light SOUL nudge (once)
  const soulPath = path.join(hermesHome, "SOUL.md");
  if (fs.existsSync(soulPath)) {
    let soul = fs.readFileSync(soulPath, "utf8");
    if (!soul.includes("SuperCompress")) {
      soul = `${soul.trimEnd()}\n\nWhen context dumps get large, prefer SuperCompress digests (MCP compress_context / inbox) over re-pasting raw tool output.\n`;
      fs.writeFileSync(soulPath, soul);
      installed.push("SOUL.md");
    }
  }

  return { configPath, hooksDest, pluginDest, instructionPath, installed };
}

function pluginDetected(plugin) {
  // Explicitly registered custom plugins always count as present
  if (plugin.alwaysInstall || (!plugin.builtin && plugin.id)) {
    const customs = loadCustomPlugins();
    if (customs.some((p) => p.id === plugin.id)) return true;
  }
  for (const cmd of plugin.detectCommands || []) {
    if (commandExists(cmd)) return true;
  }
  for (const dir of plugin.detectDirs || []) {
    const full = path.isAbsolute(dir) ? dir : path.join(HOME, dir);
    if (fs.existsSync(full)) return true;
  }
  if (plugin.configPath && fs.existsSync(path.dirname(plugin.configPath))) return true;
  return false;
}

function installPlugin(plugin, { force = false } = {}) {
  const should = force || plugin.alwaysInstall || pluginDetected(plugin);
  if (!should) return null;

  if (plugin.format !== "instruction-only") {
    if (!plugin.configPath) {
      throw new Error(`Plugin ${plugin.id} missing configPath`);
    }
    const writer = FORMAT_WRITERS[plugin.format];
    if (!writer) throw new Error(`No writer for format ${plugin.format}`);
    writer.write(plugin.configPath);
    for (const extra of plugin.extraWriters || []) {
      const fmt = extra.format || "mcp-json";
      const cfg = expandHome(extra.configPath);
      if (!cfg) continue;
      const w = FORMAT_WRITERS[fmt];
      if (w) w.write(cfg);
    }
  }

  if (plugin.instructionPath) {
    writeInstructionFile(plugin.instructionPath);
  }
  return plugin.name;
}

function uninstallPlugin(plugin) {
  const removed = [];
  const writer = FORMAT_WRITERS[plugin.format];
  if (writer && plugin.configPath && writer.remove && writer.remove(plugin.configPath)) {
    removed.push(plugin.name);
  }
  for (const extra of plugin.extraWriters || []) {
    const fmt = extra.format || "mcp-json";
    const cfg = expandHome(extra.configPath);
    const w = FORMAT_WRITERS[fmt];
    if (w && cfg && w.remove(cfg)) removed.push(`${plugin.name} (extra)`);
  }
  return removed;
}

function configurePluginAgents({ force = false } = {}) {
  const configured = [];
  for (const plugin of allPlugins()) {
    try {
      // Customs always refresh; builtins respect detect unless force
      const useForce = force || Boolean(plugin.alwaysInstall);
      const name = installPlugin(plugin, { force: useForce });
      if (name) configured.push(name);
    } catch (err) {
      console.error(`  ✗ Failed to configure ${plugin.name} MCP: ${err.message}`);
    }
  }
  return configured;
}

function removePluginAgents() {
  const removed = [];
  for (const plugin of allPlugins()) {
    try {
      removed.push(...uninstallPlugin(plugin));
    } catch (err) {
      console.error(`  ✗ Failed to remove ${plugin.name} MCP: ${err.message}`);
    }
  }
  return removed;
}

function catalogEntries() {
  return allPlugins().map((p) => ({
    name: p.name,
    commands: p.detectCommands || [],
    directories: p.detectDirs || [],
    description: `${p.name} MCP via ${p.format}${p.builtin ? "" : " (custom plugin)"}`,
    plugin: true,
    pluginId: p.id,
    format: p.format,
  }));
}

function saveCustomPlugins(plugins) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  const payload = {
    version: 1,
    plugins: plugins.map((p) => ({
      id: p.id,
      name: p.name,
      format: p.format,
      configPath: p.configPath,
      detectCommands: p.detectCommands,
      detectDirs: p.detectDirs,
      instructionPath: p.instructionPath || undefined,
      wrapBin: p.wrapBin || undefined,
      enabled: p.enabled !== false,
      alwaysInstall: p.alwaysInstall !== false,
    })),
  };
  fs.writeFileSync(PLUGINS_FILE, JSON.stringify(payload, null, 2) + "\n");
  // Drop-in example so the plugins/ folder is discoverable
  const example = path.join(PLUGINS_DIR, "example.custom-agent.json");
  if (!fs.existsSync(example)) {
    fs.writeFileSync(
      example,
      JSON.stringify(
        {
          id: "example-agent",
          name: "Example Agent",
          format: "mcp-json",
          configPath: "~/.example-agent/mcp.json",
          detectCommands: ["example-agent"],
          detectDirs: [".example-agent"],
          enabled: false,
          _comment: "Copy/rename this file, set enabled:true, then run: supercompress plugin",
        },
        null,
        2
      ) + "\n"
    );
  }
  return PLUGINS_FILE;
}

function addCustomPlugin(spec) {
  const plugin = normalizePlugin({ ...spec, builtin: false, alwaysInstall: true });
  if (!plugin) throw new Error("Invalid plugin spec (need id/name)");
  const existing = loadRegistryPlugins().filter((p) => p.id !== plugin.id);
  existing.push(plugin);
  const file = saveCustomPlugins(existing);
  try {
    installPlugin(plugin, { force: true });
  } catch (err) {
    console.error(`  ⚠ Saved plugin but install failed: ${err.message}`);
  }
  return { plugin, file };
}

function removeCustomPlugin(id) {
  const target = String(id || "").trim().toLowerCase();
  const registry = loadRegistryPlugins();
  const all = loadCustomPlugins();
  const plugin = all.find((p) => p.id === target || p.name.toLowerCase() === target);
  if (!plugin) {
    const builtin = BUILTIN_PLUGINS.map(normalizePlugin).find(
      (p) => p.id === target || p.name.toLowerCase() === target
    );
    if (builtin) {
      uninstallPlugin(builtin);
      return { removed: builtin, file: null };
    }
    throw new Error(`No custom plugin "${id}"`);
  }
  uninstallPlugin(plugin);
  // Only rewrite the registry file — never promote drop-ins into it
  const nextRegistry = registry.filter((p) => p.id !== plugin.id);
  const file = saveCustomPlugins(nextRegistry);
  if (fs.existsSync(PLUGINS_DIR)) {
    for (const name of fs.readdirSync(PLUGINS_DIR)) {
      if (!name.endsWith(".json") || name === "example.custom-agent.json") continue;
      const full = path.join(PLUGINS_DIR, name);
      try {
        const list = loadCustomPluginFile(full);
        if (list.some((p) => p.id === plugin.id) || name === `${plugin.id}.json`) {
          fs.unlinkSync(full);
        }
      } catch {}
    }
  }
  return { removed: plugin, file };
}

function instructionTargetsFromPlugins() {
  return allPlugins()
    .filter((p) => p.instructionPath && (pluginDetected(p) || p.alwaysInstall))
    .map((p) => [p.name, p.instructionPath]);
}

/** Resolve wrap target for `supercompress wrap <id>` including custom plugins. */
function resolveWrapSpec(agentName) {
  const key = String(agentName || "").trim().toLowerCase();
  if (!key) return null;
  for (const plugin of loadCustomPlugins()) {
    const aliases = [plugin.id, plugin.name, plugin.wrapBin, ...(plugin.detectCommands || [])]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase());
    if (!aliases.includes(key)) continue;
    const bin = plugin.wrapBin || (plugin.detectCommands && plugin.detectCommands[0]);
    if (!bin) return null;
    return {
      bin,
      env: {
        OPENAI_BASE_URL: `http://127.0.0.1:${Number(process.env.SUPERCOMPRESS_PORT || 8080)}/v1`,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${Number(process.env.SUPERCOMPRESS_PORT || 8080)}`,
      },
      note: `${plugin.name} via proxy env (custom plugin). MCP also installed by \`supercompress plugin\`.`,
      plugin,
    };
  }
  return null;
}

module.exports = {
  BUILTIN_PLUGINS,
  FORMAT_WRITERS,
  allPlugins,
  loadCustomPlugins,
  catalogEntries,
  configurePluginAgents,
  removePluginAgents,
  addCustomPlugin,
  removeCustomPlugin,
  pluginDetected,
  installPlugin,
  writeHermesYaml,
  removeHermesYaml,
  writeHermesAutoCompress,
  writeOpenClawJson,
  writeMcpJson,
  writeInstructionFile,
  instructionBody,
  stripSupercompressInstructionBlocks,
  parseLooseJson,
  mcpStdioEntry,
  resolveWrapSpec,
  PLUGINS_FILE,
  PLUGINS_DIR,
  instructionTargetsFromPlugins,
};
