/**
 * Detector — auto-discovers coding agent installation directories and
 * configuration files, and wires them to point at the SuperCompress proxy.
 *
 * Detected agents:
 *   - Cursor          ~/.cursor/config.json or ~/Library/Application Support/Cursor/User/settings.json
 *   - Windsurf        ~/.windsurf/config.json
 *   - Continue        ~/.continue/config.json
 *   - Cline           ~/.cline/config.json
 *   - Claude Code     ~/.claude/settings.json
 *   - Codex           ~/.codex/config.toml and `codex` in PATH
 *   - Aider           ~/.aider.conf.yml or ~/.config/aider/conf.yml
 *   - Zed             macOS app + ~/Library/Application Support/Zed/settings.json
 *                     (context_servers MCP — not Cursor-style mcpServers)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const agentPlugins = require("./agent-plugins");

const HOME = os.homedir();
const PROXY_BASE = "http://localhost:8080/v1";
const MCP_SERVER_PATH = path.join(__dirname, "mcp.js");
const CONFIG_DIR = process.env.SUPERCOMPRESS_CONFIG_DIR || path.join(HOME, ".supercompress");
const BACKUP_PATH = path.join(CONFIG_DIR, "agent-config-backups.json");

function loadBackups() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BACKUP_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveBackups(backups) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(BACKUP_PATH, JSON.stringify(backups, null, 2) + "\n");
}

/** Preserve the exact pre-setup contents so uninstall never loses user config. */
function backupFile(filePath) {
  const backups = loadBackups();
  if (Object.prototype.hasOwnProperty.call(backups, filePath)) return;
  backups[filePath] = fs.existsSync(filePath)
    ? { exists: true, content: fs.readFileSync(filePath, "utf8") }
    : { exists: false, content: "" };
  saveBackups(backups);
}

function restoreBackups() {
  const backups = loadBackups();
  const restored = new Set();
  for (const [filePath, snapshot] of Object.entries(backups)) {
    try {
      if (snapshot.exists) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, snapshot.content);
      } else if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      restored.add(filePath);
    } catch (err) {
      console.error(`  ✗ Failed to restore ${filePath}: ${err.message}`);
    }
  }
  try { fs.unlinkSync(BACKUP_PATH); } catch {}
  return restored;
}

// Shared by the instruction writer and the uninstaller so the two cannot drift.
function instructionTargets() {
  const base = [
    ["Claude Code", path.join(HOME, ".claude", "CLAUDE.md")],
    ["Codex", path.join(HOME, ".codex", "AGENTS.md")],
    ["Aider", path.join(HOME, ".aider", "CONVENTIONS.md")],
    ["Goose", path.join(HOME, ".config", "goose", "AGENTS.md")],
    ["OpenCode", path.join(HOME, ".config", "opencode", "AGENTS.md")],
    ["Hermes", path.join(HOME, ".hermes", "AGENTS.md")],
    ["OpenClaw", path.join(HOME, ".openclaw", "AGENTS.md")],
  ];
  const seen = new Set(base.map(([name]) => name));
  for (const [name, filePath] of agentPlugins.instructionTargetsFromPlugins()) {
    if (seen.has(name)) continue;
    seen.add(name);
    base.push([name, filePath]);
  }
  return base;
}

/** Static fallback list (uninstall/prune paths that load before custom plugins). */
const INSTRUCTION_TARGETS = [
  ["Claude Code", path.join(HOME, ".claude", "CLAUDE.md")],
  ["Codex", path.join(HOME, ".codex", "AGENTS.md")],
  ["Aider", path.join(HOME, ".aider", "CONVENTIONS.md")],
  ["Goose", path.join(HOME, ".config", "goose", "AGENTS.md")],
  ["OpenCode", path.join(HOME, ".config", "opencode", "AGENTS.md")],
  ["Hermes", path.join(HOME, ".hermes", "AGENTS.md")],
  ["OpenClaw", path.join(HOME, ".openclaw", "AGENTS.md")],
];

const CURSOR_RULE_DIRS = [
  path.join(HOME, ".cursor", "rules"),
  path.join(HOME, ".config", "cursor", "rules"),
];

// Claude-style hook configs written by writeAgentPromptHooks.
const AGENT_HOOK_TARGETS = [
  ["Claude Code", path.join(HOME, ".claude", "settings.json"), false],
  ["Codex", path.join(HOME, ".codex", "hooks.json"), true],
];

/**
 * True when a hook command belongs to SuperCompress. Accepts both path
 * separators so Windows registrations are matched too, and the env-prefixed
 * form (`SUPERCOMPRESS_AGENT_NAME=… /path/to/hook.js`).
 */
function isSuperCompressCommand(command) {
  const cmd = String(command || "");
  return /[\\/]supercompress[\\/]/i.test(cmd) || /\bSUPERCOMPRESS_[A-Z_]+=/.test(cmd);
}

/**
 * Remove SuperCompress instruction blocks from an agent instruction file,
 * leaving the user's own content untouched. Matches on the block heading so it
 * covers every variant shipped so far ("· context only", "· Headroom-parity"),
 * and repeats, so files that accumulated duplicate blocks are fully cleaned.
 */
function stripInstructionBlock(text) {
  // Stop at the next heading of any level — a user section starting with "##"
  // must not be swallowed along with the block.
  return text
    .replace(/\n*# SuperCompress \(always on[\s\S]*?(?=\n#{1,6} |$)/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "");
}

function writeMcpJson(filePath) {
  let data = {};
  if (fs.existsSync(filePath)) {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  }
  data.mcpServers = data.mcpServers || {};
  // Subscription/login-safe plugin registration:
  // - no provider base-URL rewrite
  // - no broken "${SUPERCOMPRESS_API_KEY}" placeholder (Cursor does not expand it)
  // - MCP reads the linked account key from ~/.supercompress/config.json
  data.mcpServers.supercompress = {
    command: process.execPath,
    args: [MCP_SERVER_PATH],
    env: {
      SUPERCOMPRESS_CONFIG_DIR: CONFIG_DIR,
    },
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function parseJsonc(text) {
  // Enough for OpenCode config: strip // and /* */ comments outside strings.
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
  return JSON.parse(out);
}

function resolveMcpLaunchCommand() {
  // Prefer the published bin on PATH so upgrades don't leave a stale absolute path.
  if (commandExists("supercompress-mcp")) {
    return ["supercompress-mcp"];
  }
  return [process.execPath, MCP_SERVER_PATH];
}

function writeOpenCodeMcp(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let data = {};
  let hadExisting = false;
  if (fs.existsSync(filePath)) {
    hadExisting = true;
    try {
      data = parseJsonc(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
      // Never wipe a user's OpenCode config if parse fails.
      throw new Error(`OpenCode config is not valid JSON/JSONC (${filePath}): ${err.message}`);
    }
  }
  if (hadExisting && (!data || typeof data !== "object" || Array.isArray(data))) {
    throw new Error(`OpenCode config must be a JSON object (${filePath})`);
  }
  data.mcp = data.mcp || {};
  // OpenCode schema: type "local", command array, enabled, timeout (default 5s is too tight).
  data.mcp.supercompress = {
    type: "local",
    command: resolveMcpLaunchCommand(),
    enabled: true,
    timeout: 60000,
    environment: {
      SUPERCOMPRESS_CONFIG_DIR: CONFIG_DIR,
    },
  };
  // Prefer a longer global MCP timeout when the field is absent (OpenCode quirks).
  data.experimental = data.experimental && typeof data.experimental === "object"
    ? data.experimental
    : {};
  if (data.experimental.mcp_timeout == null) {
    data.experimental.mcp_timeout = 120000;
  }
  // Preserve .jsonc extension but write valid JSON (OpenCode accepts it).
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

/** macOS / Linux / Windows locations for Zed's user settings.json */
function zedSettingsCandidates() {
  return [
    path.join(HOME, "Library", "Application Support", "Zed", "settings.json"),
    path.join(HOME, ".config", "zed", "settings.json"),
    path.join(HOME, "AppData", "Roaming", "Zed", "settings.json"),
  ];
}

function zedHomeDirs() {
  return [
    path.join(HOME, "Library", "Application Support", "Zed"),
    path.join(HOME, ".config", "zed"),
    path.join(HOME, "AppData", "Roaming", "Zed"),
  ];
}

/**
 * True when the real Zed editor is installed.
 * Avoid treating the zsh `zed` builtin / unrelated PATH stubs as Zed.
 */
function zedInstalled() {
  if (appExists("Zed") || appExists("Zed Preview")) return true;
  if (zedHomeDirs().some((dir) => fs.existsSync(dir))) return true;
  // Prefer absolute binaries over bare `which zed` (zsh ships a `zed` function).
  const bins = [
    path.join("/Applications", "Zed.app", "Contents", "MacOS", "cli"),
    path.join("/Applications", "Zed.app", "Contents", "MacOS", "zed"),
    path.join(HOME, "Applications", "Zed.app", "Contents", "MacOS", "cli"),
    path.join(HOME, "Applications", "Zed.app", "Contents", "MacOS", "zed"),
    path.join("/opt/homebrew/bin", "zed"),
    path.join("/usr/local/bin", "zed"),
    path.join(HOME, ".local", "bin", "zed"),
  ];
  return bins.some((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function resolveZedSettingsPath() {
  const existing = zedSettingsCandidates().find((p) => fs.existsSync(p));
  if (existing) return existing;
  // Prefer the platform-native config home when creating settings for the first time.
  if (process.platform === "darwin") {
    return path.join(HOME, "Library", "Application Support", "Zed", "settings.json");
  }
  if (process.platform === "win32") {
    return path.join(HOME, "AppData", "Roaming", "Zed", "settings.json");
  }
  return path.join(HOME, ".config", "zed", "settings.json");
}

/** Zed uses context_servers (not mcpServers). See https://zed.dev/docs/ai/mcp */
function writeZedMcp(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let data = {};
  let hadExisting = false;
  if (fs.existsSync(filePath)) {
    hadExisting = true;
    try {
      data = parseJsonc(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
      throw new Error(`Zed settings are not valid JSON/JSONC (${filePath}): ${err.message}`);
    }
  }
  if (hadExisting && (!data || typeof data !== "object" || Array.isArray(data))) {
    throw new Error(`Zed settings must be a JSON object (${filePath})`);
  }

  const launch = resolveMcpLaunchCommand();
  const command = launch[0];
  const args = launch.slice(1);
  data.context_servers = data.context_servers && typeof data.context_servers === "object"
    ? data.context_servers
    : {};
  // Strip any mistaken Cursor-style registration from older setup runs.
  if (data.mcpServers && data.mcpServers.supercompress) {
    delete data.mcpServers.supercompress;
    if (Object.keys(data.mcpServers).length === 0) delete data.mcpServers;
  }
  data.context_servers.supercompress = {
    command,
    args,
    env: {
      SUPERCOMPRESS_CONFIG_DIR: CONFIG_DIR,
    },
  };
  // Make MCP tools available in the default agent profile when profiles exist.
  data.agent = data.agent && typeof data.agent === "object" ? data.agent : {};
  if (data.agent.enable_all_context_servers == null) {
    data.agent.enable_all_context_servers = true;
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function shouldWriteMcpTarget(name, filePath, detect) {
  if (typeof detect === "function") return detect();
  if (fs.existsSync(filePath)) return true;
  const dir = path.dirname(filePath);
  if (dir !== HOME && fs.existsSync(dir)) return true;
  if (name === "Claude Code") {
    return fs.existsSync(path.join(HOME, ".claude")) || commandExists("claude");
  }
  if (name === "FreeBuff") {
    return (
      commandExists("freebuff") ||
      commandExists("codebuff") ||
      fs.existsSync(path.join(HOME, ".config", "manicode")) ||
      fs.existsSync(path.join(HOME, ".agents"))
    );
  }
  return false;
}

function configureMcp() {
  const configured = [];

  // Standard mcpServers JSON (Cursor-style) — write for every detected host.
  const mcpJsonTargets = [
    ["Cursor", path.join(HOME, ".cursor", "mcp.json"), () =>
      commandExists("cursor") || appExists("Cursor") || fs.existsSync(path.join(HOME, ".cursor"))],
    ["Gemini CLI", path.join(HOME, ".gemini", "settings.json"), () =>
      commandExists("gemini") || fs.existsSync(path.join(HOME, ".gemini"))],
    ["Claude Code", path.join(HOME, ".claude.json"), () =>
      commandExists("claude") || fs.existsSync(path.join(HOME, ".claude"))],
    ["FreeBuff", path.join(HOME, ".agents", "mcp.json"), null],
    ["Windsurf", path.join(HOME, ".codeium", "windsurf", "mcp_config.json"), () =>
      commandExists("windsurf") || appExists("Windsurf") || fs.existsSync(path.join(HOME, ".codeium", "windsurf"))],
    ["Windsurf (alt)", path.join(HOME, ".windsurf", "mcp.json"), () =>
      fs.existsSync(path.join(HOME, ".windsurf"))],
    ["Continue", path.join(HOME, ".continue", "config.json"), () =>
      fs.existsSync(path.join(HOME, ".continue"))],
    ["Goose", path.join(HOME, ".config", "goose", "config.yaml"), () =>
      commandExists("goose") || fs.existsSync(path.join(HOME, ".config", "goose"))],
    ["Crush", path.join(HOME, ".config", "crush", "mcp.json"), () =>
      commandExists("crush") || fs.existsSync(path.join(HOME, ".config", "crush"))],
    ["Amp", path.join(HOME, ".amp", "mcp.json"), () =>
      commandExists("amp") || fs.existsSync(path.join(HOME, ".amp"))],
    ["VS Code Copilot", path.join(HOME, ".copilot", "mcp.json"), () =>
      commandExists("copilot") || commandExists("github-copilot") || fs.existsSync(path.join(HOME, ".copilot"))],
    ["Roo Code", path.join(HOME, ".roo", "mcp.json"), () =>
      commandExists("roo") || fs.existsSync(path.join(HOME, ".roo"))],
    ["Cline", path.join(HOME, ".cline", "mcp.json"), () =>
      fs.existsSync(path.join(HOME, ".cline"))],
  ];

  for (const [name, filePath, detect] of mcpJsonTargets) {
    if (!shouldWriteMcpTarget(name, filePath, detect)) continue;
    try {
      // Goose uses YAML — skip JSON writer (instructions via wrap + AGENTS.md)
      if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
        continue;
      }
      backupFile(filePath);
      writeMcpJson(filePath);
      configured.push(name);
    } catch (err) {
      console.error(`  ✗ Failed to configure ${name} MCP: ${err.message}`);
    }
  }

  // OpenCode uses opencode.jsonc `mcp` block (not mcpServers).
  const openCodePaths = [
    path.join(HOME, ".config", "opencode", "opencode.jsonc"),
    path.join(HOME, ".config", "opencode", "opencode.json"),
  ];
  const openCodeInstalled =
    commandExists("opencode") ||
    fs.existsSync(path.join(HOME, ".opencode")) ||
    fs.existsSync(path.join(HOME, ".config", "opencode"));
  if (openCodeInstalled) {
    const target = openCodePaths.find((p) => fs.existsSync(p)) || openCodePaths[0];
    try {
      backupFile(target);
      writeOpenCodeMcp(target);
      configured.push("OpenCode");
    } catch (err) {
      console.error(`  ✗ Failed to configure OpenCode MCP: ${err.message}`);
    }
  }

  // Zed uses settings.json `context_servers` (not mcpServers).
  if (zedInstalled()) {
    const zedPath = resolveZedSettingsPath();
    try {
      backupFile(zedPath);
      writeZedMcp(zedPath);
      configured.push("Zed");
    } catch (err) {
      console.error(`  ✗ Failed to configure Zed MCP: ${err.message}`);
    }
  }

  const codexPath = path.join(HOME, ".codex", "config.toml");
  if (fs.existsSync(codexPath) || commandExists("codex")) {
    try {
      fs.mkdirSync(path.dirname(codexPath), { recursive: true });
      backupFile(codexPath);
      let raw = fs.existsSync(codexPath) ? fs.readFileSync(codexPath, "utf8") : "";
      const block =
        `[mcp_servers.supercompress]\n` +
        `command = ${JSON.stringify(process.execPath)}\n` +
        `args = [${JSON.stringify(MCP_SERVER_PATH)}]\n` +
        `[mcp_servers.supercompress.env]\n` +
        `SUPERCOMPRESS_CONFIG_DIR = ${JSON.stringify(CONFIG_DIR)}\n`;
      if (/^\[mcp_servers\.supercompress\]/m.test(raw)) {
        // Always refresh command/args/env so upgrades don't leave a stale MCP path.
        raw = raw
          .replace(/\n?\[mcp_servers\.supercompress\.env\][\s\S]*?(?=\n\[|$)/, "\n")
          .replace(/\n?\[mcp_servers\.supercompress\][\s\S]*?(?=\n\[|$)/, "\n");
        raw = `${raw.trimEnd()}\n\n${block}`;
      } else {
        raw = `${raw.trimEnd()}\n\n${block}`;
      }
      fs.writeFileSync(codexPath, raw.startsWith("\n") ? raw.slice(1) : raw);
      configured.push("Codex MCP");
    } catch (err) { console.error(`  ✗ Failed to configure Codex MCP: ${err.message}`); }
  }

  // Hermes, OpenClaw, and user-registered custom agents (pluggable)
  for (const name of agentPlugins.configurePluginAgents()) {
    if (!configured.includes(name)) configured.push(name);
  }

  return configured;
}

function removeMcpJson(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!data.mcpServers || !data.mcpServers.supercompress) return false;
  delete data.mcpServers.supercompress;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
  return true;
}

function removeMcp() {
  const removed = [];
  for (const [name, filePath] of [
    ["Cursor", path.join(HOME, ".cursor", "mcp.json")],
    ["Gemini CLI", path.join(HOME, ".gemini", "settings.json")],
    ["Claude Code", path.join(HOME, ".claude.json")],
    ["FreeBuff", path.join(HOME, ".agents", "mcp.json")],
  ]) {
    try {
      if (removeMcpJson(filePath)) removed.push(name);
    } catch (err) {
      console.error(`  ✗ Failed to remove ${name} MCP registration: ${err.message}`);
    }
  }

  for (const filePath of [
    path.join(HOME, ".config", "opencode", "opencode.jsonc"),
    path.join(HOME, ".config", "opencode", "opencode.json"),
  ]) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const data = parseJsonc(fs.readFileSync(filePath, "utf8"));
      if (!data.mcp || !data.mcp.supercompress) continue;
      delete data.mcp.supercompress;
      if (data.mcp && Object.keys(data.mcp).length === 0) delete data.mcp;
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
      removed.push("OpenCode");
    } catch (err) {
      console.error(`  ✗ Failed to remove OpenCode MCP registration: ${err.message}`);
    }
  }

  for (const filePath of zedSettingsCandidates()) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const data = parseJsonc(fs.readFileSync(filePath, "utf8"));
      let changed = false;
      if (data.context_servers && data.context_servers.supercompress) {
        delete data.context_servers.supercompress;
        if (Object.keys(data.context_servers).length === 0) delete data.context_servers;
        changed = true;
      }
      if (data.mcpServers && data.mcpServers.supercompress) {
        delete data.mcpServers.supercompress;
        if (Object.keys(data.mcpServers).length === 0) delete data.mcpServers;
        changed = true;
      }
      if (changed) {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
        removed.push("Zed");
      }
    } catch (err) {
      console.error(`  ✗ Failed to remove Zed MCP registration: ${err.message}`);
    }
  }

  const codexPath = path.join(HOME, ".codex", "config.toml");
  try {
    if (fs.existsSync(codexPath)) {
      const raw = fs.readFileSync(codexPath, "utf8");
      const cleaned = raw
        .replace(/\n?\[mcp_servers\.supercompress\.env\][\s\S]*?(?=\n\[|$)/, "\n")
        .replace(/\n?\[mcp_servers\.supercompress\][\s\S]*?(?=\n\[|$)/, "\n");
      if (cleaned !== raw) {
        fs.writeFileSync(codexPath, cleaned.trimEnd() + "\n");
        removed.push("Codex MCP");
      }
    }
  } catch (err) {
    console.error(`  ✗ Failed to remove Codex MCP registration: ${err.message}`);
  }

  for (const name of agentPlugins.removePluginAgents()) {
    if (!removed.includes(name)) removed.push(name);
  }
  return removed;
}

function commandExists(command) {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    const candidates = [
      path.join(HOME, ".opencode", "bin", command),
      path.join(HOME, ".local", "bin", command),
      path.join("/opt/homebrew/bin", command),
      path.join("/usr/local/bin", command),
    ];
    return candidates.some((candidate) => {
      try {
        return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
  }
}

function appExists(appName) {
  return [
    path.join("/Applications", `${appName}.app`),
    path.join(HOME, "Applications", `${appName}.app`),
  ].some((candidate) => fs.existsSync(candidate));
}

// ── Agent definitions ──

const AGENTS = [
  {
    name: "Cursor",
    detect: () => {
      // Cursor stores config in ~/Library/Application Support/Cursor/User/settings.json (macOS)
      // or ~/.cursor/config.json
      const paths = [
        path.join(HOME, "Library", "Application Support", "Cursor", "User", "settings.json"),
        path.join(HOME, ".cursor", "config.json"),
        path.join(HOME, "AppData", "Roaming", "Cursor", "User", "settings.json"), // Windows
      ];
      return paths.find((p) => fs.existsSync(p));
    },
    read: (filePath) => {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch { return {}; }
    },
    write: (filePath, config) => {
      fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
    },
    configure: (config, revert) => {
      if (revert) {
        // Only clear values we wrote — never wipe a user's custom API base.
        if (config["openAiBaseUrl"] === PROXY_BASE) delete config["openAiBaseUrl"];
        if (config["openAIBaseUrl"] === PROXY_BASE) delete config["openAIBaseUrl"];
      } else {
        config["openAiBaseUrl"] = PROXY_BASE;
      }
      return config;
    },
    description: "Change Cursor → Settings → Models → Override OpenAI Base URL to http://localhost:8080/v1",
  },
  {
    name: "Windsurf",
    detect: () => {
      const paths = [
        path.join(HOME, ".windsurf", "config.json"),
        path.join(HOME, ".config", "windsurf", "config.json"),
      ];
      return paths.find((p) => fs.existsSync(p));
    },
    read: (filePath) => {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch { return {}; }
    },
    write: (filePath, config) => {
      fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
    },
    configure: (config, revert) => {
      if (revert) {
        if (config["apiBaseUrl"] === PROXY_BASE) delete config["apiBaseUrl"];
        if (config["api_base_url"] === PROXY_BASE) delete config["api_base_url"];
      } else {
        config["apiBaseUrl"] = PROXY_BASE;
      }
      return config;
    },
    description: "Change Windsurf → Settings → API Endpoint → http://localhost:8080/v1",
  },
  {
    name: "Continue",
    detect: () => {
      const paths = [
        path.join(HOME, ".continue", "config.json"),
        path.join(HOME, ".continue", "config.yaml"),
      ];
      return paths.find((p) => fs.existsSync(p));
    },
    read: (filePath) => {
      try {
        const content = fs.readFileSync(filePath, "utf8");
        if (filePath.endsWith(".json")) {
          return { type: "json", data: JSON.parse(content), raw: content };
        }
        return { type: "yaml", data: null, raw: content };
      } catch { return { type: "unknown", data: null, raw: "" }; }
    },
    write: (filePath, config) => {
      if (config.type === "json") {
        fs.writeFileSync(filePath, JSON.stringify(config.data, null, 2));
      }
      // YAML files are not auto-modified — we'll show instructions
    },
    configure: (config, revert) => {
      if (config.type !== "json") return config;
      const models = config.data.models || [];
      if (revert) {
        config.data.models = models.filter((m) => m.apiBase !== PROXY_BASE);
      } else {
        // Add a proxy model if not already present
        const hasProxy = models.some((m) => m.apiBase === PROXY_BASE);
        if (!hasProxy) {
          models.push({
            title: "SuperCompress Proxy",
            provider: "openai",
            model: "gpt-4o",
            apiBase: PROXY_BASE,
            apiKey: "sk-supercompress",
          });
          config.data.models = models;
        }
      }
      return config;
    },
    description: "Edit ~/.continue/config.json to add a model with apiBase: http://localhost:8080/v1",
  },
  {
    name: "Cline",
    detect: () => {
      const paths = [
        path.join(HOME, ".cline", "config.json"),
        path.join(HOME, ".config", "cline", "config.json"),
      ];
      return paths.find((p) => fs.existsSync(p));
    },
    read: (filePath) => {
      try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return {}; }
    },
    write: (filePath, config) => {
      fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
    },
    configure: (config, revert) => {
      if (revert) {
        if (config["openAiBaseUrl"] === PROXY_BASE) delete config["openAiBaseUrl"];
        if (config["apiBaseUrl"] === PROXY_BASE) delete config["apiBaseUrl"];
        if (config["api_base_url"] === PROXY_BASE) delete config["api_base_url"];
      } else {
        config["openAiBaseUrl"] = PROXY_BASE;
        config["apiProvider"] = "openai-compatible";
      }
      return config;
    },
    description: "In Cline settings, set API Provider → 'OpenAI Compatible' and Base URL → http://localhost:8080/v1",
  },
  {
    name: "Claude Code",
    detect: () => {
      const paths = [
        path.join(HOME, ".claude", "settings.json"),
      ];
      return paths.find((p) => fs.existsSync(p));
    },
    read: (filePath) => {
      try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return {}; }
    },
    write: (filePath, config) => {
      fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
    },
    configure: (config, revert) => {
      if (revert) {
        // Remove the anthropic base URL override
        const env = config.env || {};
        delete env["ANTHROPIC_BASE_URL"];
        config.env = env;
      } else {
        config.env = config.env || {};
        config.env["ANTHROPIC_BASE_URL"] = PROXY_BASE.replace(/\/v1$/, "");
      }
      return config;
    },
    description: "Claude Code uses ANTHROPIC_BASE_URL env var. Configure your shell profile or run: export ANTHROPIC_BASE_URL=http://localhost:8080",
  },
  {
    name: "Codex",
    detect: () => {
      const paths = [
        path.join(HOME, ".codex", "config.toml"),
        path.join(HOME, ".codex", "config.json"),
      ];
      return paths.find((p) => fs.existsSync(p));
    },
    read: (filePath) => ({
      type: filePath.endsWith(".json") ? "json" : "toml",
      raw: fs.readFileSync(filePath, "utf8"),
    }),
    write: (filePath, config) => {
      fs.writeFileSync(filePath, config.raw);
    },
    configure: (config, revert) => {
      if (config.type === "json") {
        const data = JSON.parse(config.raw || "{}");
        if (revert) delete data.openai_base_url;
        else data.openai_base_url = PROXY_BASE;
        return { ...config, raw: JSON.stringify(data, null, 2) + "\n" };
      }

      const marker = "# SuperCompress Proxy";
      const line = `openai_base_url = \"${PROXY_BASE}\"`;
      let raw = config.raw || "";
      if (revert) {
        raw = raw.replace(new RegExp(`\\n?${marker}\\n${line}\\n?`, "g"), "");
      } else if (/^openai_base_url\s*=/m.test(raw)) {
        raw = raw.replace(/^openai_base_url\s*=.*$/m, line);
      } else {
        raw = `${raw.trimEnd()}\n\n${marker}\n${line}\n`;
      }
      return { ...config, raw };
    },
    description: "Codex API mode detected. Configure ~/.codex/config.toml to use http://localhost:8080/v1, then restart Codex. ChatGPT-login/subscription mode does not expose an API key for this proxy.",
  },
  {
    name: "Aider",
    detect: () => {
      const paths = [
        path.join(HOME, ".aider.conf.yml"),
        path.join(HOME, ".config", "aider", "conf.yml"),
      ];
      return paths.find((p) => fs.existsSync(p));
    },
    read: () => ({ type: "yaml", data: null, raw: "" }),
    write: () => {},
    configure: () => null,
    description: "Run aider with: aider --openai-api-base http://localhost:8080/v1\nOr set OPENAI_API_BASE=http://localhost:8080/v1 in your shell profile.",
  },
];

// Broad detection catalog. These integrations are detected by an installed
// executable or a known local directory; only agents with a stable, tested
// config schema are auto-edited above. Every catalogued agent can still use
// the proxy through its OpenAI/Anthropic-compatible base URL or MCP support.
const EXTRA_AGENTS = [
  ["Gemini CLI", ["gemini"], [".gemini"]],
  ["GitHub Copilot CLI", ["github-copilot", "copilot"], [".copilot"]],
  ["Amazon Q Developer", ["q"], [".aws", ".amazonq"]],
  ["Roo Code", ["roo"], [".roo"]],
  ["Kilo Code", ["kilo"], [".kilo"]],
  ["OpenHands", ["openhands"], [".openhands"]],
  ["Goose", ["goose"], [".config/goose"]],
  ["OpenCode", ["opencode"], [".config/opencode", ".opencode"]],
  ["FreeBuff", ["freebuff", "codebuff"], [".config/manicode", ".agents"]],
  ["Pi", ["pi"], [".pi"]],
  ["Amp", ["amp"], [".amp"]],
  ["Plandex", ["plandex"], [".plandex"]],
  ["gptme", ["gptme"], [".gptme"]],
  ["Mentat", ["mentat"], [".mentat"]],
  ["Sweep", ["sweep"], [".sweep"]],
  ["Tabby", ["tabby"], [".tabby"]],
  ["Zed", ["zed"], [".config/zed", "Library/Application Support/Zed", "AppData/Roaming/Zed"]],
  ["Void", ["void"], [".void"]],
  ["PearAI", ["pearai"], [".pearai"]],
  ["Supermaven", ["supermaven"], [".supermaven"]],
  ["Sourcegraph Cody", ["cody"], [".cody"]],
  ["Qodo", ["qodo"], [".qodo"]],
  ["Warp AI", ["warp"], [".warp"]],
  ["Crush", ["crush"], [".config/crush"]],
  ["Replit Agent", ["replit"], [".config/replit"]],
  ["Devin", ["devin"], [".devin"]],
  ["CodeGPT", ["codegpt"], [".codegpt"]],
  ["Blackbox AI", ["blackbox"], [".blackbox"]],
  ["Tabnine", ["tabnine"], [".tabnine"]],
  ["Codeium", ["codeium"], [".codeium"]],
  ["AskCodi", ["askcodi"], [".askcodi"]],
  ["MutableAI", ["mutable"], [".mutable"]],
  ["Refact", ["refact"], [".refact"]],
  ["Twinny", ["twinny"], [".twinny"]],
  ["Mistral Vibe", ["vibe"], [".vibe"]],
  ["Claude Desktop", ["claude-desktop"], ["Library/Application Support/Claude"]],
  ["Gemini Code Assist", ["gemini-code-assist"], [".gemini"]],
  ["Google Jules", ["jules"], [".jules"]],
  ["JetBrains AI", ["idea", "pycharm", "webstorm"], ["Library/Application Support/JetBrains"]],
  ["Composio", ["composio"], [".composio"]],
  ["Pythagora", ["pythagora"], [".pythagora"]],
  ["Marvin", ["marvin"], [".marvin"]],
  ["Hermes", ["hermes"], [".hermes"]],
  ["OpenClaw", ["openclaw", "claw"], [".openclaw"]],
].map(([name, commands, directories]) => ({
  name,
  commands,
  directories,
  description: `${name} detected; configure its OpenAI/Anthropic-compatible base URL or MCP settings manually`,
}));

function buildAgentCatalog() {
  const base = [...AGENTS, ...EXTRA_AGENTS];
  const seen = new Set(base.map((a) => a.name));
  const extras = [];
  for (const entry of agentPlugins.catalogEntries()) {
    if (seen.has(entry.name)) {
      // Upgrade description for first-class MCP plugins already in EXTRA_AGENTS
      const hit = base.find((a) => a.name === entry.name);
      if (hit) {
        hit.description = entry.description;
        hit.pluginId = entry.pluginId;
        hit.format = entry.format;
        hit.autoMcp = true;
      }
      continue;
    }
    seen.add(entry.name);
    extras.push(entry);
  }
  return [...base, ...extras];
}

const AGENT_CATALOG = buildAgentCatalog();

const INSTALL_CHECKS = {
  Cursor: () => commandExists("cursor") || appExists("Cursor"),
  Windsurf: () => commandExists("windsurf") || appExists("Windsurf"),
  Continue: () => commandExists("code") && fs.existsSync(path.join(HOME, ".continue")),
  Cline: () => fs.existsSync(path.join(HOME, ".vscode", "extensions")) && fs.readdirSync(path.join(HOME, ".vscode", "extensions")).some((name) => name.startsWith("saoudrizwan.claude-dev-")),
  "Claude Code": () => commandExists("claude"),
  Aider: () => commandExists("aider"),
  Codex: () => commandExists("codex"),
  Zed: () => zedInstalled(),
};

// ── Shell profile helpers ──

function getShellProfile() {
  const shell = process.env.SHELL || "";
  if (shell.includes("zsh")) return path.join(HOME, ".zshrc");
  if (shell.includes("bash")) return path.join(HOME, ".bashrc");
  if (shell.includes("fish")) return path.join(HOME, ".config", "fish", "config.fish");
  return path.join(HOME, ".profile");
}

function addToShellProfile(varName, varValue) {
  const profilePath = getShellProfile();
  const line = `export ${varName}=${varValue}`;

  try {
    let content = "";
    if (fs.existsSync(profilePath)) {
      content = fs.readFileSync(profilePath, "utf8");
    }

    // Check if already present
    if (content.includes(`export ${varName}=`)) {
      // Replace existing
      content = content.replace(
        new RegExp(`export ${varName}=.*`, "g"),
        line
      );
    } else {
      content += `\n# SuperCompress Proxy\n${line}\n`;
    }

    fs.writeFileSync(profilePath, content);
    return true;
  } catch {
    return false;
  }
}

function removeFromShellProfile(varName) {
  const profilePath = getShellProfile();
  try {
    if (!fs.existsSync(profilePath)) return false;
    let content = fs.readFileSync(profilePath, "utf8");
    content = content.replace(
      new RegExp(`\\n?# SuperCompress Proxy\\n?`, "g"),
      ""
    );
    content = content.replace(
      new RegExp(`export ${varName}=.*\\n?`, "g"),
      ""
    );
    fs.writeFileSync(profilePath, content);
    return true;
  } catch {
    return false;
  }
}

// ── Public API ──

/**
 * Scan the machine for installed coding agents.
 * Returns an array of found agent objects.
 */
function detectAll() {
  const found = [];
  for (const agent of AGENTS) {
    const filePath = agent.detect();
    const installed = Boolean(filePath) || Boolean(INSTALL_CHECKS[agent.name]?.());
    if (installed) {
      found.push({
        name: agent.name,
        configPath: filePath,
        installed,
        autoConfigurable: Boolean(filePath),
        description: agent.description,
      });
    }
  }
  for (const agent of EXTRA_AGENTS) {
    const directory = agent.directories
      .map((relative) => path.join(HOME, relative))
      .find((candidate) => fs.existsSync(candidate));
    // Zed: never trust bare `which zed` (zsh ships an unrelated `zed` function).
    const command = agent.name === "Zed"
      ? (zedInstalled() ? "zed" : null)
      : agent.commands.find((candidate) => commandExists(candidate));
    const installedExtra = agent.name === "Zed"
      ? zedInstalled()
      : Boolean(directory || command);
    if (installedExtra) {
      found.push({
        name: agent.name,
        configPath: directory || (agent.name === "Zed" ? path.dirname(resolveZedSettingsPath()) : null),
        installed: true,
        autoConfigurable: agent.name === "Zed" || Boolean(agent.autoMcp),
        description: agent.name === "Zed"
          ? "Zed Agent MCP via settings.json context_servers (auto-configured by setup/plugin)"
          : agent.description,
      });
    }
  }
  // Custom / pluggable agents not already listed
  const foundNames = new Set(found.map((f) => f.name));
  for (const plugin of agentPlugins.allPlugins()) {
    if (foundNames.has(plugin.name)) continue;
    if (!agentPlugins.pluginDetected(plugin)) continue;
    found.push({
      name: plugin.name,
      configPath: plugin.configPath || null,
      installed: true,
      autoConfigurable: plugin.format !== "instruction-only",
      description: `${plugin.name} MCP via ${plugin.format} (custom plugin)`,
    });
  }
  return found;
}

/**
 * Configure all found agents to use the proxy.
 * Returns an array of agent names that were configured.
 */
function configureAll() {
  const configured = [];

  for (const agent of AGENTS) {
    const filePath = agent.detect();
    if (filePath) {
      try {
        const config = agent.read(filePath);
        const updated = agent.configure(config, false);
        if (updated) {
          backupFile(filePath);
          agent.write(filePath, updated);
          configured.push(agent.name);
        }
      } catch (err) {
        console.error(`  ✗ Failed to configure ${agent.name}: ${err.message}`);
      }
    }
  }

  // Claude Code reads this variable from its environment rather than a stable
  // JSON config. Only write it when the real CLI is installed.
  const claudeCode = AGENTS.find((a) => a.name === "Claude Code");
  if (claudeCode.detect() || INSTALL_CHECKS["Claude Code"]()) {
    backupFile(getShellProfile());
    addToShellProfile("ANTHROPIC_BASE_URL", PROXY_BASE.replace(/\/v1$/, ""));
    if (!configured.includes("Claude Code")) configured.push("Claude Code");
  }

  return configured;
}

/**
 * Remove the plugin-mode artifacts: the Cursor rule, the Cursor hook scripts
 * and hook registrations, the Claude/Codex/Gemini hook entries, and the
 * instruction blocks.
 *
 * These are written by writeCursorRule / writeCursorHooks /
 * writeAgentPromptHooks / writeAgentInstructionFiles. The AGENTS loop in
 * revertAll only covers the provider base-URL configs, so without this they
 * survive `uninstall` — including installs old enough to have recorded no
 * backup at all.
 *
 * @param {Set<string>} skip paths restoreBackups already returned to their
 *   pre-install contents. Deleting those would defeat the backup.
 * @returns {string[]} human-readable labels for what was removed
 */
function removePluginArtifacts(skip = new Set()) {
  const removed = [];
  const drop = (target, label) => {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(label || target);
    } catch (err) {
      console.error(`  ✗ Failed to remove ${target}: ${err.message}`);
    }
  };

  /** Drop our entries from a Claude-style {hooks:{event:[{hooks:[…]}]}} map. */
  const pruneHookMap = (events) => {
    let changed = false;
    for (const event of Object.keys(events)) {
      if (!Array.isArray(events[event])) continue;
      const kept = events[event].filter((group) => {
        if (isSuperCompressCommand(group && group.command)) return false;
        const inner = (group && group.hooks) || [];
        return !inner.some((h) => isSuperCompressCommand(h && h.command));
      });
      if (kept.length !== events[event].length) changed = true;
      if (kept.length) events[event] = kept;
      else delete events[event];
    }
    return changed;
  };

  for (const dir of CURSOR_RULE_DIRS) {
    const rule = path.join(dir, "supercompress.mdc");
    if (fs.existsSync(rule) && !skip.has(rule)) drop(rule, "Cursor rule");
  }

  const hooksDir = path.join(HOME, ".cursor", "hooks", "supercompress");
  if (fs.existsSync(hooksDir)) drop(hooksDir, "Cursor hook scripts");

  // Cursor hooks.json: drop only our entries so unrelated hooks survive.
  const hooksPath = path.join(HOME, ".cursor", "hooks.json");
  if (fs.existsSync(hooksPath) && !skip.has(hooksPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
      const events = (data && data.hooks) || {};
      if (pruneHookMap(events)) {
        if (Object.keys(events).length === 0) drop(hooksPath, "Cursor hooks.json");
        else {
          data.hooks = events;
          fs.writeFileSync(hooksPath, `${JSON.stringify(data, null, 2)}\n`);
          removed.push("Cursor hook registrations");
        }
      }
    } catch (err) {
      console.error(`  ✗ Failed to clean ${hooksPath}: ${err.message}`);
    }
  }

  // Claude Code / Codex prompt + tool hooks. Backed up since this change, but
  // installs from earlier releases have no manifest to restore from.
  for (const [name, filePath, deleteWhenEmpty] of AGENT_HOOK_TARGETS) {
    if (!fs.existsSync(filePath) || skip.has(filePath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const events = (data && data.hooks) || {};
      if (!pruneHookMap(events)) continue;
      if (Object.keys(events).length === 0) {
        delete data.hooks;
        // hooks.json exists only for hooks; settings.json holds user config.
        if (deleteWhenEmpty && Object.keys(data).length === 0) {
          drop(filePath, `${name} hooks`);
          continue;
        }
      } else {
        data.hooks = events;
      }
      fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
      removed.push(`${name} hooks`);
    } catch (err) {
      console.error(`  ✗ Failed to clean ${filePath}: ${err.message}`);
    }
  }

  // Gemini CLI carries a flag rather than hooks.
  const geminiPath = path.join(HOME, ".gemini", "settings.json");
  if (fs.existsSync(geminiPath) && !skip.has(geminiPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(geminiPath, "utf8"));
      if (data && data.supercompress) {
        delete data.supercompress;
        fs.writeFileSync(geminiPath, `${JSON.stringify(data, null, 2)}\n`);
        removed.push("Gemini CLI flag");
      }
    } catch (err) {
      console.error(`  ✗ Failed to clean ${geminiPath}: ${err.message}`);
    }
  }

  // Always strip SuperCompress blocks — even when restoreBackups already touched
  // the path. Hermes auto-install can rewrite AGENTS.md after the first backup,
  // so "restore" may put SC content back; skipping would leave residue.
  for (const [name, filePath] of instructionTargets()) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const prev = fs.readFileSync(filePath, "utf8");
      const next = stripInstructionBlock(prev);
      if (next === prev) continue;
      // Only delete when the block was the file's entire contents.
      if (!next.trim()) drop(filePath, `${name} instructions`);
      else {
        fs.writeFileSync(filePath, next.endsWith("\n") ? next : `${next}\n`);
        removed.push(`${name} instructions`);
      }
    } catch (err) {
      console.error(`  ✗ Failed to clean ${filePath}: ${err.message}`);
    }
  }

  // Hermes auto-compress copies hooks/plugins outside the instruction file.
  removed.push(...removeHermesAutoCompressArtifacts());

  return removed;
}

/** Drop Hermes agent-hooks / plugins / auto yaml written by writeHermesAutoCompress. */
function removeHermesAutoCompressArtifacts() {
  const removed = [];
  const hermesHome = path.join(HOME, ".hermes");
  if (!fs.existsSync(hermesHome)) return removed;

  const hooksDest = path.join(hermesHome, "agent-hooks", "supercompress");
  if (fs.existsSync(hooksDest)) {
    try {
      fs.rmSync(hooksDest, { recursive: true, force: true });
      removed.push("Hermes agent-hooks");
    } catch (err) {
      console.error(`  ✗ Failed to remove ${hooksDest}: ${err.message}`);
    }
  }

  const pluginDest = path.join(hermesHome, "plugins", "supercompress");
  if (fs.existsSync(pluginDest)) {
    try {
      fs.rmSync(pluginDest, { recursive: true, force: true });
      removed.push("Hermes transform plugin");
    } catch (err) {
      console.error(`  ✗ Failed to remove ${pluginDest}: ${err.message}`);
    }
  }

  const configPath = path.join(hermesHome, "config.yaml");
  if (fs.existsSync(configPath)) {
    try {
      let raw = fs.readFileSync(configPath, "utf8");
      const before = raw;
      raw = raw.replace(/\n?# supercompress-auto[\s\S]*?(?=\n# [^\n]+|\n[a-z_][a-z0-9_]*:|\n*$)/g, "\n");
      raw = raw.replace(
        /(^|\n)([ \t]*)-[ \t]*command:[^\n]*(?:pre-llm-call|post-tool-call|agent-hooks\/supercompress)[^\n]*\n(?:\2[ \t]+[^\n]*\n)*/g,
        "$1"
      );
      if (typeof agentPlugins.removeHermesYaml === "function") {
        agentPlugins.removeHermesYaml(configPath);
        raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : raw;
      }
      if (raw !== before) {
        fs.writeFileSync(configPath, raw.endsWith("\n") ? raw : `${raw}\n`);
        if (!removed.includes("Hermes MCP registration")) removed.push("Hermes auto config");
      }
    } catch (err) {
      console.error(`  ✗ Failed to clean Hermes config: ${err.message}`);
    }
  }

  return removed;
}

/**
 * Revert all agent configs back to original state.
 * Returns an array of agent names that were reverted.
 */
function revertAll() {
  const reverted = [];
  const restored = restoreBackups();

  for (const agent of AGENTS) {
    const filePath = agent.detect();
    if (filePath && restored.has(filePath)) {
      reverted.push(`Reverted ${agent.name}`);
      continue;
    }
    if (filePath) {
      try {
        const config = agent.read(filePath);
        const updated = agent.configure(config, true);
        if (updated) {
          agent.write(filePath, updated);
          reverted.push(`Reverted ${agent.name}`);
        }
      } catch {}
    }
  }

  const shellProfile = getShellProfile();
  if (!restored.has(shellProfile)) {
    removeFromShellProfile("ANTHROPIC_BASE_URL");
    removeFromShellProfile("OPENAI_API_BASE");
  }

  // Runs last, and skips whatever restoreBackups already returned to its
  // pre-install contents — otherwise a user's own file at one of these paths
  // would be restored and then deleted.
  return reverted.concat(removePluginArtifacts(restored).map((a) => `Removed ${a}`));
}

/**
 * Remove provider base-URL overrides that force API-key proxy mode.
 * Leaves MCP plugin registrations intact.
 */
function clearProxyOverrides() {
  const cleared = [];
  for (const agent of AGENTS) {
    const filePath = agent.detect();
    if (!filePath) continue;
    try {
      const config = agent.read(filePath);
      const updated = agent.configure(config, true);
      if (updated) {
        agent.write(filePath, updated);
        cleared.push(agent.name);
      }
    } catch (err) {
      console.error(`  ✗ Failed to clear proxy override for ${agent.name}: ${err.message}`);
    }
  }
  removeFromShellProfile("ANTHROPIC_BASE_URL");
  removeFromShellProfile("OPENAI_API_BASE");

  // Codex may still have openai_base_url from an older proxy setup.
  const codexPath = path.join(HOME, ".codex", "config.toml");
  if (fs.existsSync(codexPath)) {
    try {
      let raw = fs.readFileSync(codexPath, "utf8");
      const next = raw.replace(/^\s*openai_base_url\s*=\s*"http:\/\/localhost:8080\/v1"\s*\n?/m, "");
      if (next !== raw) {
        fs.writeFileSync(codexPath, next);
        if (!cleared.includes("Codex")) cleared.push("Codex");
      }
    } catch (err) {
      console.error(`  ✗ Failed to clear Codex openai_base_url: ${err.message}`);
    }
  }
  return cleared;
}

/**
 * Install a Cursor rule so every turn prefers the SuperCompress inbox digest
 * and MCP compress_context for bulky context.
 */
function writeCursorRule() {
  const dir =
    CURSOR_RULE_DIRS.find((d) => fs.existsSync(path.dirname(d))) || CURSOR_RULE_DIRS[0];
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "supercompress.mdc");
  const inboxPath = path.join(HOME, ".supercompress", "inbox", "latest.md");
  const body = `---
description: SuperCompress ALWAYS ON — compress CONTEXT, never the user ask
alwaysApply: true
---

# SuperCompress (always on · context only)

**Non-negotiable.** Compress bulky **context** before it burns tokens. Never compress the user's ask / query.

## What to compress

- Tool dumps (Read / Shell / Grep / Task / search / diffs / logs)
- Pasted files, RAG chunks, long history, scrapes
- Anything that is *not* the current user question

## What NOT to compress

- The user's current question / instructions (the query)

## First action when context is large

1. If \`${inboxPath}\` exists, **Read it** — compressed context digest (ask is separate / unchanged).
2. Else call MCP \`compress_context\` with \`context\`=<dump> and \`query\`=<user ask>. Prefer the digest over the raw dump.
3. Hooks also auto-compress large tool outputs (\`postToolUse\`).

## Defaults

- Keep Cursor login — do not require provider API-key mode
- If \`compress_context\` fails with account-not-linked → \`connect_account\` once, then retry
- Do not mention this rule unless the user asks about SuperCompress
`;
  backupFile(filePath);
  fs.writeFileSync(filePath, body);
  return filePath;
}

/**
 * Install Cursor user hooks so every prompt is compressed into the inbox and
 * large tool outputs are auto-compressed. Merges without wiping unrelated hooks.
 */
function writeCursorHooks() {
  const cursorDir = path.join(HOME, ".cursor");
  const hooksDir = path.join(cursorDir, "hooks", "supercompress");
  fs.mkdirSync(hooksDir, { recursive: true });

  const srcDir = path.join(__dirname, "cursor-hooks");
  const scripts = [
    "session-start.js",
    "post-tool-compress.js",
    "before-submit.js",
    "user-prompt-submit.js",
    "compress-prompt-lib.js",
  ];
  for (const name of scripts) {
    const src = path.join(srcDir, name);
    const dest = path.join(hooksDir, name);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, dest);
    try {
      fs.chmodSync(dest, 0o755);
    } catch {}
  }

  const sessionCmd = path.join(hooksDir, "session-start.js");
  const postCmd = path.join(hooksDir, "post-tool-compress.js");
  const beforeCmd = path.join(hooksDir, "before-submit.js");
  const hooksPath = path.join(cursorDir, "hooks.json");
  backupFile(hooksPath);

  let existing = { version: 1, hooks: {} };
  if (fs.existsSync(hooksPath)) {
    try {
      let raw = fs.readFileSync(hooksPath, "utf8");
      raw = raw.replace(/\\n\s*$/, "").trim();
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") existing = parsed;
    } catch (err) {
      try {
        fs.copyFileSync(hooksPath, `${hooksPath}.bak-${Date.now()}`);
      } catch {}
      console.error(`  ⚠ Could not parse existing hooks.json (${err.message}); merging onto empty base after backup.`);
      existing = { version: 1, hooks: {} };
    }
  }
  if (!existing.hooks || typeof existing.hooks !== "object") existing.hooks = {};
  if (!existing.version) existing.version = 1;

  // Shared with the uninstaller so install-time dedupe and uninstall-time
  // cleanup agree — notably on Windows, where the command holds backslashes.
  const isOurs = (entry) => isSuperCompressCommand(entry && entry.command);

  const ensureHook = (event, entry) => {
    const list = Array.isArray(existing.hooks[event])
      ? existing.hooks[event].filter((e) => !isOurs(e))
      : [];
    list.push(entry);
    existing.hooks[event] = list;
  };

  ensureHook("sessionStart", { command: sessionCmd, timeout: 10 });
  // Cursor beforeSubmitPrompt — no matcher (fires on every user submit)
  ensureHook("beforeSubmitPrompt", {
    command: `SUPERCOMPRESS_AGENT_NAME=Cursor ${beforeCmd}`,
    timeout: 20,
  });
  // Tag Cursor explicitly — without this, post-tool used to mislabel as Claude Code
  // whenever the payload had session_id/cwd (which Cursor always sends).
  ensureHook("postToolUse", {
    command: `SUPERCOMPRESS_AGENT_NAME=Cursor ${postCmd}`,
    timeout: 20,
    matcher: "Read|Shell|Grep|Task|AwaitShell|WebFetch|WebSearch|MCP:.*|Edit|Write|Glob",
  });

  fs.writeFileSync(hooksPath, `${JSON.stringify(existing, null, 2)}\n`);
  return { hooksPath, hooksDir };
}

function syncHookScripts() {
  const hooksDir = path.join(HOME, ".cursor", "hooks", "supercompress");
  fs.mkdirSync(hooksDir, { recursive: true });
  const srcDir = path.join(__dirname, "cursor-hooks");
  for (const name of [
    "session-start.js",
    "post-tool-compress.js",
    "before-submit.js",
    "user-prompt-submit.js",
    "compress-prompt-lib.js",
  ]) {
    const src = path.join(srcDir, name);
    const dest = path.join(hooksDir, name);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, dest);
    try { fs.chmodSync(dest, 0o755); } catch {}
  }
  return hooksDir;
}

function upsertClaudeStyleHook(data, eventName, command, matcher) {
  data.hooks = data.hooks || {};
  const groups = Array.isArray(data.hooks[eventName]) ? data.hooks[eventName] : [];
  const filtered = groups.filter((g) => {
    const hooks = (g && g.hooks) || [];
    return !hooks.some((h) => String(h.command || "").includes("supercompress"));
  });
  const entry = {
    hooks: [{ type: "command", command, timeout: 20 }],
  };
  if (matcher) entry.matcher = matcher;
  filtered.push(entry);
  data.hooks[eventName] = filtered;
}

/**
 * Install Claude Code + Codex (+ Gemini when present) every-message + tool hooks.
 */
function writeAgentPromptHooks() {
  const hooksDir = syncHookScripts();
  const promptCmd = path.join(hooksDir, "user-prompt-submit.js");
  const postCmd = path.join(hooksDir, "post-tool-compress.js");
  const installed = [];

  // Claude Code ~/.claude/settings.json — prompt + PostToolUse (true auto on tool dumps)
  const claudePath = path.join(HOME, ".claude", "settings.json");
  if (commandExists("claude") || fs.existsSync(path.join(HOME, ".claude")) || fs.existsSync(claudePath)) {
    try {
      let data = {};
      if (fs.existsSync(claudePath)) data = JSON.parse(fs.readFileSync(claudePath, "utf8"));
      backupFile(claudePath);
      upsertClaudeStyleHook(data, "UserPromptSubmit", promptCmd);
      upsertClaudeStyleHook(
        data,
        "PostToolUse",
        `SUPERCOMPRESS_AGENT_NAME="Claude Code" ${postCmd}`,
        ".*"
      );
      fs.mkdirSync(path.dirname(claudePath), { recursive: true });
      fs.writeFileSync(claudePath, `${JSON.stringify(data, null, 2)}\n`);
      installed.push("Claude Code");
    } catch (err) {
      console.error(`  ⚠ Claude Code hooks: ${err.message}`);
    }
  }

  // Codex ~/.codex/hooks.json
  const codexPath = path.join(HOME, ".codex", "hooks.json");
  if (commandExists("codex") || fs.existsSync(path.join(HOME, ".codex")) || fs.existsSync(codexPath)) {
    try {
      let data = { hooks: {} };
      if (fs.existsSync(codexPath)) data = JSON.parse(fs.readFileSync(codexPath, "utf8"));
      backupFile(codexPath);
      upsertClaudeStyleHook(data, "UserPromptSubmit", `SUPERCOMPRESS_AGENT_NAME=Codex ${promptCmd}`);
      upsertClaudeStyleHook(
        data,
        "PostToolUse",
        `SUPERCOMPRESS_AGENT_NAME=Codex ${postCmd}`,
        ".*"
      );
      fs.mkdirSync(path.dirname(codexPath), { recursive: true });
      fs.writeFileSync(codexPath, `${JSON.stringify(data, null, 2)}\n`);
      installed.push("Codex");
    } catch (err) {
      console.error(`  ⚠ Codex hooks: ${err.message}`);
    }
  }

  // Gemini CLI — settings.json may accept hooks in newer builds; also ensure MCP
  const geminiPath = path.join(HOME, ".gemini", "settings.json");
  if (commandExists("gemini") || fs.existsSync(path.join(HOME, ".gemini"))) {
    try {
      let data = {};
      if (fs.existsSync(geminiPath)) data = JSON.parse(fs.readFileSync(geminiPath, "utf8"));
      backupFile(geminiPath);
      if (!data.mcpServers) data.mcpServers = {};
      // MCP already written by configureMcp; add soft instruction flag
      data.supercompress = { ...(data.supercompress || {}), auto: true };
      fs.mkdirSync(path.dirname(geminiPath), { recursive: true });
      fs.writeFileSync(geminiPath, `${JSON.stringify(data, null, 2)}\n`);
      installed.push("Gemini CLI");
    } catch (err) {
      console.error(`  ⚠ Gemini CLI: ${err.message}`);
    }
  }

  return { cmd: promptCmd, postCmd, installed };
}

/**
 * Always-on instruction files so agents that lack hooks still prefer compress_context.
 */
function writeAgentInstructionFiles() {
  const written = [];
  const inboxPath = path.join(HOME, ".supercompress", "inbox", "latest.md");
  const body = [
    "# SuperCompress (always on · context only)",
    "",
    "Compress bulky **context** (tool dumps, files, logs, diffs, history). Never compress the user's ask/query.",
    "",
    "1. If `" + inboxPath + "` exists, Read it — compressed context digest (ask is unchanged).",
    "2. Otherwise call MCP `compress_context` with `context`=<dump> and `query`=<user ask>.",
    "3. Prefer the digest over raw dumps. Keep normal login — no provider API-key mode required.",
    "4. If compress_context fails with account-not-linked, call `connect_account` once, then retry.",
    "",
  ].join("\n");

  for (const [name, filePath] of instructionTargets()) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir) && name !== "Claude Code" && name !== "Codex") {
        // Only create instruction files when the agent home already exists
        if (!fs.existsSync(path.dirname(dir)) && !commandExists(name.split(" ")[0].toLowerCase())) {
          continue;
        }
      }
      const existsAgent =
        fs.existsSync(dir) ||
        // Custom / pluggable agents: always write once registered (mkdir below)
        agentPlugins.loadCustomPlugins().some((p) => p.name === name) ||
        (name === "Claude Code" && (commandExists("claude") || fs.existsSync(path.join(HOME, ".claude")))) ||
        (name === "Codex" && (commandExists("codex") || fs.existsSync(path.join(HOME, ".codex")))) ||
        (name === "Aider" && commandExists("aider")) ||
        (name === "Goose" && commandExists("goose")) ||
        (name === "OpenCode" && commandExists("opencode")) ||
        (name === "Hermes" && (commandExists("hermes") || fs.existsSync(path.join(HOME, ".hermes")))) ||
        (name === "OpenClaw" && (commandExists("openclaw") || commandExists("claw") || fs.existsSync(path.join(HOME, ".openclaw"))));
      if (!existsAgent) continue;

      fs.mkdirSync(dir, { recursive: true });
      backupFile(filePath);
      let next = body;
      if (fs.existsSync(filePath)) {
        const prev = fs.readFileSync(filePath, "utf8");
        if (/SuperCompress \(always on/i.test(prev)) {
          next = prev.replace(
            /# SuperCompress \(always on[^\n]*\)[\s\S]*?(?=\n# (?!#)|\n*$)/,
            body.trim() + "\n\n"
          );
          // If the heading variant didn't match the regex, avoid appending a duplicate.
          if (next === prev) {
            next = prev; // already present under a recognized heading
          }
        } else {
          next = `${prev.trimEnd()}\n\n${body}`;
        }
      }
      fs.writeFileSync(filePath, next.endsWith("\n") ? next : `${next}\n`);
      written.push(name);
    } catch (err) {
      console.error(`  ⚠ ${name} instructions: ${err.message}`);
    }
  }
  return written;
}

/**
 * Full auto install: MCP everywhere detected + Cursor/Claude/Codex hooks + instruction files.
 * This is the default path used by `supercompress setup` / `plugin`.
 */
function installAutoPlugin() {
  const found = detectAll();
  const mcpConfigured = configureMcp();
  const rulePath = writeCursorRule();
  const hooks = writeCursorHooks();
  const agentHooks = writeAgentPromptHooks();
  const instructions = writeAgentInstructionFiles();
  let hermes = null;
  if (commandExists("hermes") || fs.existsSync(path.join(HOME, ".hermes"))) {
    try {
      const hermesHome = path.join(HOME, ".hermes");
      // Backup before auto-compress rewrites AGENTS.md / config.yaml.
      backupFile(path.join(hermesHome, "AGENTS.md"));
      backupFile(path.join(hermesHome, "config.yaml"));
      hermes = agentPlugins.writeHermesAutoCompress(hermesHome);
    } catch (err) {
      console.error(`  ⚠ Hermes auto-compress: ${err.message}`);
    }
  }
  const cleared = clearProxyOverrides();
  return {
    found,
    mcpConfigured,
    rulePath,
    hooks,
    agentHooks,
    instructions,
    hermes,
    cleared,
  };
}

module.exports = {
  detectAll,
  configureAll,
  configureMcp,
  removeMcp,
  revertAll,
  removePluginArtifacts,
  stripInstructionBlock,
  clearProxyOverrides,
  AGENTS,
  AGENT_CATALOG,
  writeCursorRule,
  writeCursorHooks,
  writeAgentPromptHooks,
  writeAgentInstructionFiles,
  installAutoPlugin,
  agentPlugins,
};
