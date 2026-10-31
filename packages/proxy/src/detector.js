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
 *   - fx (Vercel)     ~/.fx/mcp.json (trusted profile only) + ~/.fx/AGENTS.md + skills
 *   - OpenCode        ~/.config/opencode/opencode.json(c) mcp block
 *   - Grok Bot        hosted Streamable HTTP MCP (cloud) — always offered by setup/plugin
 *   - Any custom      `supercompress agents connect` / Agent Plugins pack / agents add
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const agentPlugins = require("./agent-plugins");
const edit = require("./config-edit");

const HOME = os.homedir();
const PROXY_BASE = "http://localhost:8080/v1";
const SC_ANTHROPIC_BASE = PROXY_BASE.replace(/\/v1$/, "");
const MCP_SERVER_PATH = path.join(__dirname, "mcp.js");
const CONFIG_DIR = process.env.SUPERCOMPRESS_CONFIG_DIR || path.join(HOME, ".supercompress");
const BACKUP_PATH = path.join(CONFIG_DIR, "agent-config-backups.json");

const guidance = require("./agent-guidance");
/** Cloud-reachable MCP for Grok Bot / marketplace HTTP hosts (stdio is not reachable). */
const HOSTED_MCP_URL = "https://www.supercompress.dev/api/mcp";

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
  // Same manifest/format as agent-plugins.recordOriginal (first write wins).
  const backups = loadBackups();
  if (Object.prototype.hasOwnProperty.call(backups, filePath)) return;
  backups[filePath] = fs.existsSync(filePath)
    ? { exists: true, content: fs.readFileSync(filePath, "utf8") }
    : { exists: false, content: "" };
  saveBackups(backups);
}

// Backups being reverted by the current `revertAll` (null outside uninstall).
let activeBackups = null;

function currentBackups() {
  return activeBackups || loadBackups();
}

/**
 * Files SuperCompress owns outright (its own rule / skill / hook file). A
 * backup at one of these paths is a user's file that setup overwrote, so the
 * whole snapshot goes back. Every other backed-up file is shared with the
 * user and is only ever edited surgically.
 */
function isOwnedArtifact(filePath) {
  const rel = path.relative(HOME, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  if ([".cursor/hooks/mcp-response.js", ".hermes/agent-hooks/mcp-response.js", ".hermes/plugins/mcp-response.js", ".openclaw/hooks/mcp-response.js", ".openclaw/extensions/mcp-response.js"].includes(rel.split(path.sep).join("/"))) return true;
  return rel.split(/[\\/]/).some((seg) => /^supercompress(?:\.[a-z]+)?$/i.test(seg));
}

/**
 * Restore whole-file snapshots for owned artifacts only.
 *
 * Shared configs (Codex/Grok config.toml, mcp.json, settings.json, YAML, …)
 * are never rewound to their install-time snapshot: that wiped every MCP
 * server and setting the user added after setup. They are cleaned by the
 * surgical removers instead, and `finalizeSharedConfigs` restores the
 * snapshot bytes only when nothing but formatting would change.
 */
function restoreOwnedArtifacts(backups) {
  const restored = new Set();
  for (const [filePath, snapshot] of Object.entries(backups)) {
    if (!isOwnedArtifact(filePath) || !snapshot) continue;
    try {
      if (snapshot.exists) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, snapshot.content);
      } else if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        const dir = path.dirname(filePath);
        if (/^supercompress$/i.test(path.basename(dir))) {
          try { fs.rmdirSync(dir); } catch {} // only succeeds when empty
        }
      }
      restored.add(filePath);
    } catch (err) {
      console.error(`  ✗ Failed to restore ${filePath}: ${err.message}`);
    }
  }
  return restored;
}

/** Text of a file before setup: string, "" if it did not exist, null if unknown. */
function originalText(filePath, backups = currentBackups()) {
  const snap = backups[filePath];
  if (!snap || typeof snap !== "object") return null;
  if (!snap.exists) return "";
  return typeof snap.content === "string" ? snap.content : null;
}

/** Parsed pre-setup JSON object: {} if the file did not exist, null if unknown. */
function originalJson(filePath, backups = currentBackups()) {
  const text = originalText(filePath, backups);
  if (text === null) return null;
  if (!text.trim()) return {};
  try {
    const data = edit.parseJsonLoose(text);
    return edit.isPlainObject(data) ? data : null;
  } catch {
    return null;
  }
}

/** True when `obj[key]` should be deleted because setup created it. */
function createdBySetup(original, ...keys) {
  if (!original) return false; // unknown pre-install state — keep it
  let cur = original;
  for (const k of keys) {
    if (!edit.isPlainObject(cur) || !Object.prototype.hasOwnProperty.call(cur, k)) return true;
    cur = cur[k];
  }
  return false;
}

/** Delete an emptied container that setup created (or that was already gone). */
function pruneEmpty(data, key, original, parentKeys = []) {
  const v = data[key];
  if (!edit.isPlainObject(v) && !Array.isArray(v)) return;
  const empty = Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0;
  if (!empty) return;
  // Keep a container the user had before setup; drop one we introduced. With
  // no snapshot (legacy installs) keep the historical behaviour of dropping it.
  if (original && !createdBySetup(original, ...parentKeys, key)) return;
  delete data[key];
}

/**
 * Restore one key SuperCompress overwrote. Only acts while the key still holds
 * our value — if the user changed it since, their value wins.
 */
function revertKey(obj, key, scValue, original) {
  if (!edit.isPlainObject(obj) || obj[key] !== scValue) return false;
  if (edit.isPlainObject(original) &&
      Object.prototype.hasOwnProperty.call(original, key) &&
      original[key] !== scValue) {
    obj[key] = original[key];
  } else {
    delete obj[key];
  }
  return true;
}

/**
 * Surgically remove SuperCompress MCP entries from a live config file without
 * touching other servers the user may have added after install. Malformed or
 * missing files are left untouched.
 */
function stripSupercompressMcpFromFile(filePath) {
  const original = originalJson(filePath);
  return edit.editJsonFile(filePath, (data) => {
    for (const key of ["mcpServers", "mcp"]) {
      if (edit.isPlainObject(data[key]) && data[key].supercompress) {
        delete data[key].supercompress;
        pruneEmpty(data, key, original);
      }
    }
  });
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
    ["Grok Build", path.join(process.env.GROK_HOME || path.join(HOME, ".grok"), "AGENTS.md")],
    ["fx", path.join(HOME, ".fx", "AGENTS.md")],
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
  ["Grok Build", path.join(process.env.GROK_HOME || path.join(HOME, ".grok"), "AGENTS.md")],
  ["fx", path.join(HOME, ".fx", "AGENTS.md")],
];

const CURSOR_RULE_DIRS = [
  path.join(HOME, ".cursor", "rules"),
  path.join(HOME, ".config", "cursor", "rules"),
];

// Claude-style hook configs written by writeAgentPromptHooks.
const AGENT_HOOK_TARGETS = [
  ["Claude Code", path.join(HOME, ".claude", "settings.json"), false],
  ["Codex", path.join(HOME, ".codex", "hooks.json"), true],
  ["Grok Build", path.join(process.env.GROK_HOME || path.join(HOME, ".grok"), "hooks", "supercompress.json"), true],
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

function resolveNodeBin() {
  // Prefer PATH `node` over Homebrew Cellar-pinned process.execPath — brew
  // upgrades otherwise leave every agent MCP entry pointing at a deleted binary.
  if (commandExists("node")) return "node";
  return process.execPath;
}

function whichPath(command) {
  try {
    const out = execFileSync("which", [command], { encoding: "utf8" }).trim();
    const first = out.split("\n")[0].trim();
    if (first && fs.existsSync(first)) return first;
  } catch {}
  return null;
}

function resolveNodeBinAbsolute() {
  return whichPath("node") || (commandExists("node") ? "node" : process.execPath);
}

/**
 * Launch command for MCP stdio servers.
 * Default: PATH `node` + this package's mcp.js (stable across brew upgrades;
 * GUI apps like Cursor often lack npm global bins on PATH).
 * Set preferShim for CLIs that reliably have `supercompress-mcp` on PATH.
 * Set absoluteNode for hosts (Grok) whose spawn PATH may not include `node`.
 */
function resolveMcpLaunchCommand({ preferShim = true, absoluteNode = false } = {}) {
  // Prefer the global `supercompress-mcp` shim when present — cleaner agent
  // configs (one argv) and survives package moves better than a pinned mcp.js path.
  // Callers that need a stable absolute node+script (fx, some sandboxes) pass preferShim:false.
  if (preferShim && commandExists("supercompress-mcp")) {
    return [whichPath("supercompress-mcp") || "supercompress-mcp"];
  }
  return [absoluteNode ? resolveNodeBinAbsolute() : resolveNodeBin(), MCP_SERVER_PATH];
}

/** Upsert `[mcp_servers.supercompress]` in Codex / Grok-style TOML configs. */
function upsertTomlMcpServer(filePath, {
  agentName = null,
  extra = {},
  inlineEnv = false,
  preferShim = false,
  absoluteNode = false,
} = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  backupFile(filePath);
  let raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const launch = resolveMcpLaunchCommand({ preferShim, absoluteNode });
  const envLines = [
    `SUPERCOMPRESS_CONFIG_DIR = ${JSON.stringify(CONFIG_DIR)}`,
  ];
  if (agentName) {
    envLines.push(`SUPERCOMPRESS_AGENT_NAME = ${JSON.stringify(agentName)}`);
  }
  let block =
    `[mcp_servers.supercompress]\n` +
    `command = ${JSON.stringify(launch[0])}\n` +
    (launch.length > 1
      ? `args = [${launch
          .slice(1)
          .map((a) => JSON.stringify(a))
          .join(", ")}]\n`
      : `args = []\n`);
  if (extra.startup_timeout_sec != null) {
    block += `startup_timeout_sec = ${Number(extra.startup_timeout_sec)}\n`;
  }
  if (extra.tool_timeout_sec != null) {
    block += `tool_timeout_sec = ${Number(extra.tool_timeout_sec)}\n`;
  }
  if (extra.enabled != null) {
    block += `enabled = ${extra.enabled ? "true" : "false"}\n`;
  }
  if (inlineEnv) {
    block += `env = { ${envLines.join(", ")} }\n`;
  } else {
    block +=
      `[mcp_servers.supercompress.env]\n` +
      envLines.map((l) => `${l}\n`).join("");
  }
  raw = edit.removeTomlTable(raw, "mcp_servers.supercompress");
  raw = raw.trim() ? `${raw.trimEnd()}\n\n${block}` : block;
  fs.writeFileSync(filePath, raw);
}

/** Grok truncates MCP tool results at 20KB unless raised — compress digests are larger. */
function upsertGrokMcpOutputCap(filePath, floor = 2_000_000) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  backupFile(filePath);
  let raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const mcpIdx = raw.search(/^\[mcp\]\s*$/m);
  if (mcpIdx < 0) {
    raw = `${raw.trimEnd()}\n\n[mcp]\nmax_output_bytes = ${floor}\n`;
    fs.writeFileSync(filePath, raw.startsWith("\n") ? raw.slice(1) : raw);
    return;
  }
  const after = raw.slice(mcpIdx);
  const next = after.search(/\n\[/);
  const section = next >= 0 ? after.slice(0, next) : after;
  const rest = next >= 0 ? after.slice(next) : "";
  const prefix = raw.slice(0, mcpIdx);
  const current = section.match(/^\s*max_output_bytes\s*=\s*(\d+)/m);
  if (current && Number(current[1]) >= floor) return;
  const newSection = current
    ? section.replace(/^\s*max_output_bytes\s*=\s*\d+/m, `max_output_bytes = ${floor}`)
    : section.replace(/^\[mcp\]\s*\n/, `[mcp]\nmax_output_bytes = ${floor}\n`);
  fs.writeFileSync(filePath, prefix + newSection + rest);
}

function grokSkillDest() {
  return path.join(grokHome(), "skills", "supercompress", "SKILL.md");
}

function writeGrokSkill() {
  const src = path.join(__dirname, "grok-hooks", "skills", "supercompress", "SKILL.md");
  if (!fs.existsSync(src)) return false;
  const dest = grokSkillDest();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  backupFile(dest);
  fs.copyFileSync(src, dest);
  return true;
}

function grokInstructionBody(inboxPath) {
  return [
    "# SuperCompress (always on · context only)",
    "",
    guidance.COMPRESS_INTRO,
    "",
    ...guidance.COMPRESS_WHAT.map((line) => line.replace("MCP `compress_context`", "MCP `supercompress__compress_context`")),
    "",
    "## How it works in Grok Build",
    "- Hooks auto-compress large tool outputs. PostToolUse replaces the model's copy of the tool result with the digest (`updatedToolOutput`).",
    "- Digests are also written to `" + inboxPath + "` (and `inbox/<sessionId>/`).",
    "- Grok discards UserPromptSubmit additionalContext — do not wait for the next prompt; the replaced tool result is the mid-turn path.",
    "",
    "## Playbook",
    "1. Prefer the PostToolUse-replaced tool result when present.",
    "2. Else if `" + inboxPath + "` exists, **Read it** — compressed digest (ask is unchanged). Session digests may also be at `~/.supercompress/inbox/<sessionId>/latest.md`.",
    "3. Otherwise call `supercompress__compress_context` with only the new dump and work from the digest. If that tool is not listed, `search_tool` then `use_tool` with `supercompress__compress_context`.",
    "4. If the digest dropped a line you need, re-read just that part of the source.",
    "5. If it says the account is not linked, call `supercompress__connect_account` once, give the user its link, then retry.",
    "6. " + guidance.runwayRule({ tool: "supercompress__runway_check" }),
    "",
  ].join("\n");
}

/** Remove `[mcp_servers.supercompress]` (+ sub-tables) only; every other byte stays. */
function removeTomlMcpServer(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const raw = fs.readFileSync(filePath, "utf8");
  const cleaned = edit.removeTomlTable(raw, "mcp_servers.supercompress");
  if (cleaned === raw) return false;
  fs.writeFileSync(filePath, cleaned);
  return true;
}

/**
 * Undo `upsertGrokMcpOutputCap`: put back the pre-install `[mcp]
 * max_output_bytes` (or drop it, plus an `[mcp]` table we created). Skipped
 * when the user changed the value since, or the original is unknown.
 */
function restoreGrokMcpOutputCap(filePath, floor = 2_000_000) {
  if (!fs.existsSync(filePath)) return false;
  const before = originalText(filePath);
  if (before === null) return false;
  const raw = fs.readFileSync(filePath, "utf8");
  const cur = edit.findTomlKey(raw, "mcp", "max_output_bytes");
  if (!cur || Number(cur.value) !== floor) return false;
  const orig = edit.findTomlKey(before, "mcp", "max_output_bytes");
  let next;
  if (orig) {
    if (Number(orig.value) === floor) return false;
    next = edit.replaceTomlLine(raw, cur.index, orig.line);
  } else {
    next = edit.replaceTomlLine(raw, cur.index, null);
    if (!edit.hasExactTomlTable(before, "mcp")) next = edit.dropEmptyTomlTable(next, "mcp");
  }
  if (next === raw) return false;
  fs.writeFileSync(filePath, next);
  return true;
}

function grokHome() {
  return process.env.GROK_HOME || path.join(HOME, ".grok");
}

function grokInstalled() {
  return commandExists("grok") || fs.existsSync(grokHome());
}

function grokBotHome() {
  return path.join(CONFIG_DIR, "hosts", "grok-bot");
}

function grokBotMcpPath() {
  return path.join(grokBotHome(), "mcp.json");
}

/** Always offered — Grok Bot is cloud-hosted; setup writes a paste-ready hosted MCP snippet. */
function grokBotAvailable() {
  return true;
}

function writeGrokBotHostedMcp() {
  const dir = grokBotHome();
  fs.mkdirSync(dir, { recursive: true });
  const file = grokBotMcpPath();
  backupFile(file);
  const payload = {
    mcpServers: {
      supercompress: {
        url: HOSTED_MCP_URL,
      },
    },
    install: `Add this MCP server: ${HOSTED_MCP_URL}`,
    note:
      "Grok Bot runs in the cloud — paste the URL in Grok Bot MCP settings, then complete Google OAuth once. Local stdio MCP is not reachable from Grok Bot.",
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(
    path.join(dir, "INSTALL.txt"),
    `Add this MCP server: ${HOSTED_MCP_URL}\n`
  );
  return file;
}

function removeGrokBotHostedMcp() {
  const dir = grokBotHome();
  if (!fs.existsSync(dir)) return false;
  try {
    for (const name of ["mcp.json", "INSTALL.txt"]) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    try {
      fs.rmdirSync(dir);
    } catch {
      /* keep parent hosts/ */
    }
    return true;
  } catch {
    return false;
  }
}

function fxHome() {
  return process.env.FX_HOME || path.join(HOME, ".fx");
}

function fxInstalled() {
  return (
    commandExists("fx") ||
    fs.existsSync(fxHome()) ||
    fs.existsSync(path.join(fxHome(), "mcp.json"))
  );
}

/** fx trusted profile — only ~/.fx/mcp.json (repo-local MCP is never loaded). */
function writeFxMcp() {
  const filePath = path.join(fxHome(), "mcp.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  backupFile(filePath);
  let data = { mcp: {} };
  if (fs.existsSync(filePath)) {
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
      throw new Error(`fx mcp.json is not valid JSON (${filePath}): ${err.message}`);
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`fx mcp.json must be a JSON object (${filePath})`);
  }
  data.mcp = data.mcp && typeof data.mcp === "object" ? data.mcp : {};
  const launch = resolveMcpLaunchCommand({ absoluteNode: true });
  data.mcp.supercompress = {
    type: "local",
    command: launch,
    enabled: true,
    required: false,
    environment: {
      SUPERCOMPRESS_CONFIG_DIR: CONFIG_DIR,
      SUPERCOMPRESS_AGENT_NAME: "fx",
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
  return filePath;
}

function removeFxMcp() {
  return stripSupercompressMcpFromFile(path.join(fxHome(), "mcp.json"));
}

function writeFxSkill() {
  const src = path.join(__dirname, "..", "agent-plugin", "skills", "supercompress", "SKILL.md");
  const dest = path.join(fxHome(), "skills", "supercompress", "SKILL.md");
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  backupFile(dest);
  fs.copyFileSync(src, dest);
  return true;
}

function removeFxSkill() {
  const dest = path.join(fxHome(), "skills", "supercompress", "SKILL.md");
  if (!fs.existsSync(dest)) return false;
  try {
    fs.unlinkSync(dest);
    const dir = path.dirname(dest);
    try { fs.rmdirSync(dir); } catch {}
    return true;
  } catch {
    return false;
  }
}

function fxInstructionBody(inboxPath) {
  const steps = guidance.compressSteps(inboxPath);
  steps[1] =
    "2. Otherwise find the SuperCompress MCP tools (`mcp_search_tools` / `mcp_select_tool`), call `compress_context` with only the new dump, and work from the returned digest instead of the raw text.";
  return [
    "# SuperCompress (always on · context only)",
    "",
    guidance.COMPRESS_INTRO,
    "",
    ...guidance.COMPRESS_WHAT,
    "",
    ...steps,
    "5. After installing MCP: `/mcp reload` (or restart fx).",
    "6. " + guidance.runwayRule(),
    "",
  ].join("\n");
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
  // - launch via PATH bin / `node` so npm/brew upgrades keep auth working
  const launch = resolveMcpLaunchCommand();
  data.mcpServers.supercompress = {
    command: launch[0],
    args: launch.slice(1),
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

/**
 * Goose (Block) registers MCP as YAML `extensions.<id>` with type:stdio.
 * Do not write Cursor-style mcpServers JSON into config.yaml.
 */
function writeGooseYaml(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const launch = resolveMcpLaunchCommand();
  const cmd = launch[0];
  const args = launch.slice(1);
  const argLines = args.length
    ? ["    args:", ...args.map((a) => `      - ${JSON.stringify(a)}`)]
    : ["    args: []"];
  const block = [
    "  supercompress:",
    "    enabled: true",
    "    type: stdio",
    "    name: supercompress",
    `    cmd: ${JSON.stringify(cmd)}`,
    ...argLines,
    "    timeout: 600",
    "    envs:",
    `      SUPERCOMPRESS_CONFIG_DIR: ${JSON.stringify(CONFIG_DIR)}`,
    "",
  ].join("\n");

  // Strip any prior SuperCompress extension block (indented under extensions:)
  raw = raw.replace(/(^|\n) {2}supercompress:\n(?: {4}.+\n)*/g, "$1");

  if (/^extensions:\s*$/m.test(raw) || /^extensions:\s*\n/m.test(raw)) {
    raw = raw.replace(/^(extensions:\s*\n)/m, `$1${block}`);
  } else if (/^extensions:/m.test(raw)) {
    raw = raw.replace(/^(extensions:[^\n]*\n)/m, `$1${block}`);
  } else {
    raw = `${raw.trimEnd()}\n\nextensions:\n${block}`;
  }
  fs.writeFileSync(filePath, raw.endsWith("\n") ? raw : `${raw}\n`);
}

/**
 * Continue uses experimental.modelContextProtocolServers (array), not mcpServers map.
 */
function writeContinueMcp(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let data = {};
  if (fs.existsSync(filePath)) {
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
      throw new Error(`Continue config is not valid JSON (${filePath}): ${err.message}`);
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Continue config must be a JSON object (${filePath})`);
  }
  // Remove mistaken Cursor-style registration from older setup runs
  if (data.mcpServers && data.mcpServers.supercompress) {
    delete data.mcpServers.supercompress;
    if (Object.keys(data.mcpServers).length === 0) delete data.mcpServers;
  }
  data.experimental = data.experimental && typeof data.experimental === "object"
    ? data.experimental
    : {};
  const launch = resolveMcpLaunchCommand();
  const entry = {
    transport: {
      type: "stdio",
      command: launch[0],
      args: launch.slice(1),
      env: { SUPERCOMPRESS_CONFIG_DIR: CONFIG_DIR },
    },
  };
  const list = Array.isArray(data.experimental.modelContextProtocolServers)
    ? data.experimental.modelContextProtocolServers
    : [];
  const filtered = list.filter((item) => {
    const cmd = item?.transport?.command || item?.command || "";
    const name = item?.name || "";
    return !/supercompress/i.test(String(cmd)) && !/supercompress/i.test(String(name));
  });
  filtered.push(entry);
  data.experimental.modelContextProtocolServers = filtered;
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
  if (name === "Claude Desktop") {
    return (
      appExists("Claude") ||
      fs.existsSync(path.join(HOME, "Library", "Application Support", "Claude")) ||
      fs.existsSync(path.join(HOME, "AppData", "Roaming", "Claude"))
    );
  }
  return false;
}

function resolveExtensionMcpTargets() {
  const targets = [];
  const baseDirs = [];

  if (process.platform === "darwin") {
    baseDirs.push(
      path.join(HOME, "Library", "Application Support", "Code", "User", "globalStorage"),
      path.join(HOME, "Library", "Application Support", "Cursor", "User", "globalStorage"),
      path.join(HOME, "Library", "Application Support", "VSCodium", "User", "globalStorage"),
      path.join(HOME, "Library", "Application Support", "Windsurf", "User", "globalStorage"),
      path.join(HOME, "Library", "Application Support", "Code - Insiders", "User", "globalStorage")
    );
  }

  baseDirs.push(
    path.join(HOME, ".config", "Code", "User", "globalStorage"),
    path.join(HOME, ".config", "Cursor", "User", "globalStorage"),
    path.join(HOME, ".config", "VSCodium", "User", "globalStorage"),
    path.join(HOME, ".config", "Windsurf", "User", "globalStorage"),
    path.join(HOME, ".config", "Code - Insiders", "User", "globalStorage")
  );

  if (process.env.APPDATA) {
    baseDirs.push(
      path.join(process.env.APPDATA, "Code", "User", "globalStorage"),
      path.join(process.env.APPDATA, "Code - Insiders", "User", "globalStorage"),
      path.join(process.env.APPDATA, "Cursor", "User", "globalStorage"),
      path.join(process.env.APPDATA, "VSCodium", "User", "globalStorage"),
      path.join(process.env.APPDATA, "Windsurf", "User", "globalStorage")
    );
  }

  const extensions = [
    { name: "Roo Code", id: "rooveterinaryinc.roo-cline", file: "cline_mcp_settings.json" },
    { name: "Cline", id: "saoudrizwan.claude-dev", file: "cline_mcp_settings.json" },
    { name: "Kodu", id: "kodu.kodu", file: "cline_mcp_settings.json" },
    { name: "Kilo Code", id: "kilocode.kilo-code", file: "cline_mcp_settings.json" },
  ];

  for (const base of baseDirs) {
    for (const ext of extensions) {
      const extDir = path.join(base, ext.id);
      const settingsPath = path.join(extDir, "settings", ext.file);
      targets.push([
        ext.name,
        settingsPath,
        () => fs.existsSync(extDir) || fs.existsSync(settingsPath),
      ]);
    }
  }

  return targets;
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
    ["Crush", path.join(HOME, ".config", "crush", "mcp.json"), () =>
      commandExists("crush") || fs.existsSync(path.join(HOME, ".config", "crush"))],
    ["Amp", path.join(HOME, ".amp", "mcp.json"), () =>
      commandExists("amp") || fs.existsSync(path.join(HOME, ".amp"))],
    ["Pi", path.join(HOME, ".pi", "mcp.json"), () =>
      commandExists("pi") || fs.existsSync(path.join(HOME, ".pi"))],
    ["Void", path.join(HOME, ".void", "mcp.json"), () =>
      commandExists("void") || fs.existsSync(path.join(HOME, ".void"))],
    ["PearAI", path.join(HOME, ".pearai", "mcp.json"), () =>
      commandExists("pearai") || fs.existsSync(path.join(HOME, ".pearai"))],
    ["Mistral Vibe", path.join(HOME, ".vibe", "mcp.json"), () =>
      commandExists("vibe") || fs.existsSync(path.join(HOME, ".vibe"))],
    ["Kilo Code", path.join(HOME, ".kilo", "mcp.json"), () =>
      commandExists("kilo") || fs.existsSync(path.join(HOME, ".kilo"))],
    ["VS Code Copilot", path.join(HOME, ".copilot", "mcp.json"), () =>
      commandExists("copilot") || commandExists("github-copilot") || fs.existsSync(path.join(HOME, ".copilot"))],
    ["Roo Code", path.join(HOME, ".roo", "mcp.json"), () =>
      commandExists("roo") || fs.existsSync(path.join(HOME, ".roo"))],
    ["Cline", path.join(HOME, ".cline", "mcp.json"), () =>
      fs.existsSync(path.join(HOME, ".cline"))],
    ["Claude Desktop", path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json"), () =>
      process.platform === "darwin" &&
      (appExists("Claude") || fs.existsSync(path.join(HOME, "Library", "Application Support", "Claude")))],
    ["Claude Desktop", path.join(HOME, "AppData", "Roaming", "Claude", "claude_desktop_config.json"), () =>
      process.platform === "win32" &&
      fs.existsSync(path.join(HOME, "AppData", "Roaming", "Claude"))],
    ...resolveExtensionMcpTargets(),
  ];

  for (const [name, filePath, detect] of mcpJsonTargets) {
    if (!shouldWriteMcpTarget(name, filePath, detect)) continue;
    try {
      if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) continue;
      backupFile(filePath);
      writeMcpJson(filePath);
      if (!configured.includes(name)) configured.push(name);
    } catch (err) {
      console.error(`  ✗ Failed to configure ${name} MCP: ${err.message}`);
    }
  }

  // Continue — experimental.modelContextProtocolServers array (not mcpServers map)
  const continuePath = path.join(HOME, ".continue", "config.json");
  if (fs.existsSync(path.join(HOME, ".continue"))) {
    try {
      backupFile(continuePath);
      writeContinueMcp(continuePath);
      if (!configured.includes("Continue")) configured.push("Continue");
    } catch (err) {
      console.error(`  ✗ Failed to configure Continue MCP: ${err.message}`);
    }
  }

  // Goose — YAML extensions.supercompress (stdio MCP)
  const goosePath = path.join(HOME, ".config", "goose", "config.yaml");
  if (commandExists("goose") || fs.existsSync(path.join(HOME, ".config", "goose"))) {
    try {
      backupFile(goosePath);
      writeGooseYaml(goosePath);
      if (!configured.includes("Goose")) configured.push("Goose");
    } catch (err) {
      console.error(`  ✗ Failed to configure Goose MCP: ${err.message}`);
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
      upsertTomlMcpServer(codexPath);
      configured.push("Codex MCP");
    } catch (err) {
      console.error(`  ✗ Failed to configure Codex MCP: ${err.message}`);
    }
  }

  // Grok Build (xAI) — native [mcp_servers.*] + inline env (Grok's documented TOML shape)
  if (grokInstalled()) {
    try {
      const grokPath = path.join(grokHome(), "config.toml");
      upsertTomlMcpServer(grokPath, {
        agentName: "Grok Build",
        extra: { startup_timeout_sec: 60, tool_timeout_sec: 600, enabled: true },
        inlineEnv: true,
        absoluteNode: true,
      });
      upsertGrokMcpOutputCap(grokPath);
      configured.push("Grok Build");
    } catch (err) {
      console.error(`  ✗ Failed to configure Grok Build MCP: ${err.message}`);
    }
  }

  // Grok Bot (xAI cloud) — hosted Streamable HTTP MCP (stdio is unreachable from the bot)
  try {
    writeGrokBotHostedMcp();
    configured.push("Grok Bot");
    console.log(`  → Grok Bot: Add this MCP server: ${HOSTED_MCP_URL}`);
  } catch (err) {
    console.error(`  ✗ Failed to configure Grok Bot hosted MCP: ${err.message}`);
  }

  // fx (Vercel Labs) — trusted profile only at ~/.fx/mcp.json
  if (fxInstalled()) {
    try {
      writeFxMcp();
      configured.push("fx");
    } catch (err) {
      console.error(`  ✗ Failed to configure fx MCP: ${err.message}`);
    }
  }

  // Hermes, OpenClaw, and user-registered custom agents (pluggable)
  for (const name of agentPlugins.configurePluginAgents()) {
    if (!configured.includes(name)) configured.push(name);
  }

  return configured;
}

function removeMcpJson(filePath) {
  return stripSupercompressMcpFromFile(filePath);
}

function removeMcp() {
  const removed = [];
  const seen = new Set();
  const targets = [
    ["Cursor", path.join(HOME, ".cursor", "mcp.json")],
    ["Gemini CLI", path.join(HOME, ".gemini", "settings.json")],
    ["Claude Code", path.join(HOME, ".claude.json")],
    ["FreeBuff", path.join(HOME, ".agents", "mcp.json")],
    ["Windsurf", path.join(HOME, ".codeium", "windsurf", "mcp_config.json")],
    ["Windsurf (alt)", path.join(HOME, ".windsurf", "mcp.json")],
    ["Crush", path.join(HOME, ".config", "crush", "mcp.json")],
    ["Amp", path.join(HOME, ".amp", "mcp.json")],
    ["Pi", path.join(HOME, ".pi", "mcp.json")],
    ["Void", path.join(HOME, ".void", "mcp.json")],
    ["PearAI", path.join(HOME, ".pearai", "mcp.json")],
    ["Mistral Vibe", path.join(HOME, ".vibe", "mcp.json")],
    ["Kilo Code", path.join(HOME, ".kilo", "mcp.json")],
    ["VS Code Copilot", path.join(HOME, ".copilot", "mcp.json")],
    ["Roo Code", path.join(HOME, ".roo", "mcp.json")],
    ["Cline", path.join(HOME, ".cline", "mcp.json")],
    ["Claude Desktop", path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json")],
    ["Claude Desktop", path.join(HOME, "AppData", "Roaming", "Claude", "claude_desktop_config.json")],
    ["fx", path.join(HOME, ".fx", "mcp.json")],
  ];
  for (const [name, filePath] of targets) {
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    try {
      if (removeMcpJson(filePath)) removed.push(name);
    } catch (err) {
      console.error(`  ✗ Failed to remove ${name} MCP registration: ${err.message}`);
    }
  }

  // OpenCode: `mcp.supercompress` plus the `experimental.mcp_timeout` default
  // setup fills in when absent.
  for (const filePath of [
    path.join(HOME, ".config", "opencode", "opencode.jsonc"),
    path.join(HOME, ".config", "opencode", "opencode.json"),
  ]) {
    try {
      const original = originalJson(filePath);
      let hit = false;
      edit.editJsonFile(filePath, (data) => {
        if (edit.isPlainObject(data.mcp) && data.mcp.supercompress) {
          delete data.mcp.supercompress;
          pruneEmpty(data, "mcp", original);
          hit = true;
        }
        if (edit.isPlainObject(data.experimental) &&
            data.experimental.mcp_timeout === 120000 &&
            original && createdBySetup(original, "experimental", "mcp_timeout")) {
          delete data.experimental.mcp_timeout;
          pruneEmpty(data, "experimental", original);
        }
      });
      if (hit) removed.push("OpenCode");
    } catch (err) {
      console.error(`  ✗ Failed to remove OpenCode MCP registration: ${err.message}`);
    }
  }

  // Zed: `context_servers.supercompress` (+ legacy mcpServers entry) and the
  // `agent.enable_all_context_servers` default setup fills in when absent.
  for (const filePath of zedSettingsCandidates()) {
    try {
      const original = originalJson(filePath);
      let hit = false;
      edit.editJsonFile(filePath, (data) => {
        for (const key of ["context_servers", "mcpServers"]) {
          if (edit.isPlainObject(data[key]) && data[key].supercompress) {
            delete data[key].supercompress;
            pruneEmpty(data, key, original);
            hit = true;
          }
        }
        if (edit.isPlainObject(data.agent) &&
            data.agent.enable_all_context_servers === true &&
            original && createdBySetup(original, "agent", "enable_all_context_servers")) {
          delete data.agent.enable_all_context_servers;
          pruneEmpty(data, "agent", original);
        }
      });
      if (hit) removed.push("Zed");
    } catch (err) {
      console.error(`  ✗ Failed to remove Zed MCP registration: ${err.message}`);
    }
  }

  // Continue: experimental.modelContextProtocolServers array entry.
  const continuePath = path.join(HOME, ".continue", "config.json");
  try {
    const original = originalJson(continuePath);
    let hit = false;
    edit.editJsonFile(continuePath, (data) => {
      const exp = data.experimental;
      if (edit.isPlainObject(exp) && Array.isArray(exp.modelContextProtocolServers)) {
        const kept = exp.modelContextProtocolServers.filter((item) => !isSupercompressContinueServer(item));
        if (kept.length !== exp.modelContextProtocolServers.length) {
          exp.modelContextProtocolServers = kept;
          hit = true;
          if (!kept.length && (!original || createdBySetup(original, "experimental", "modelContextProtocolServers"))) {
            delete exp.modelContextProtocolServers;
          }
          pruneEmpty(data, "experimental", original);
        }
      }
      if (edit.isPlainObject(data.mcpServers) && data.mcpServers.supercompress) {
        delete data.mcpServers.supercompress;
        pruneEmpty(data, "mcpServers", original);
        hit = true;
      }
    });
    if (hit) removed.push("Continue");
  } catch (err) {
    console.error(`  ✗ Failed to remove Continue MCP registration: ${err.message}`);
  }

  // Goose: YAML extensions.supercompress block.
  try {
    if (removeGooseYaml(path.join(HOME, ".config", "goose", "config.yaml"))) removed.push("Goose");
  } catch (err) {
    console.error(`  ✗ Failed to remove Goose MCP registration: ${err.message}`);
  }

  const codexPath = path.join(HOME, ".codex", "config.toml");
  try {
    if (removeTomlMcpServer(codexPath)) removed.push("Codex MCP");
  } catch (err) {
    console.error(`  ✗ Failed to remove Codex MCP registration: ${err.message}`);
  }

  try {
    const grokPath = path.join(grokHome(), "config.toml");
    if (removeTomlMcpServer(grokPath)) removed.push("Grok Build");
    restoreGrokMcpOutputCap(grokPath);
  } catch (err) {
    console.error(`  ✗ Failed to remove Grok Build MCP registration: ${err.message}`);
  }

  try {
    if (removeGrokBotHostedMcp()) removed.push("Grok Bot");
  } catch (err) {
    console.error(`  ✗ Failed to remove Grok Bot hosted MCP: ${err.message}`);
  }

  for (const name of agentPlugins.removePluginAgents()) {
    if (!removed.includes(name)) removed.push(name);
  }

  // Hermes: drop an `mcp_servers:` key setup introduced and left empty.
  const hermesConfig = path.join(HOME, ".hermes", "config.yaml");
  try {
    if (fs.existsSync(hermesConfig)) {
      const raw = fs.readFileSync(hermesConfig, "utf8");
      const next = edit.dropEmptyYamlKey(raw, "mcp_servers", originalText(hermesConfig));
      if (next !== raw) fs.writeFileSync(hermesConfig, next);
    }
  } catch (err) {
    console.error(`  ✗ Failed to tidy Hermes config: ${err.message}`);
  }
  return removed;
}

function isSupercompressContinueServer(item) {
  const cmd = item?.transport?.command || item?.command || "";
  const name = item?.name || "";
  const env = item?.transport?.env || item?.env || {};
  return /supercompress/i.test(String(cmd)) ||
    /supercompress/i.test(String(name)) ||
    Boolean(env && typeof env === "object" && env.SUPERCOMPRESS_CONFIG_DIR);
}

/** Remove the `  supercompress:` block under Goose `extensions:` only. */
function removeGooseYaml(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const raw = fs.readFileSync(filePath, "utf8");
  let next = raw.replace(/(^|\n) {2}supercompress:[ \t]*\n(?: {4}[^\n]*(?:\n|$))*/g, "$1");
  if (next === raw) return false;
  next = edit.dropEmptyYamlKey(next, "extensions", originalText(filePath));
  fs.writeFileSync(filePath, next);
  return true;
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

/** Read a JSON/JSONC agent config; null when missing or malformed (never `{}`). */
function readJsonConfig(filePath) {
  try {
    const data = edit.parseJsonLoose(fs.readFileSync(filePath, "utf8"));
    return edit.isPlainObject(data) ? data : null;
  } catch {
    return null;
  }
}

/** Write an agent config, editing only the spans that changed. */
function writeJsonConfig(filePath, config) {
  const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  fs.writeFileSync(filePath, edit.rewriteJson(raw, config));
}

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
    read: readJsonConfig,
    write: writeJsonConfig,
    configure: (config, revert, original) => {
      if (revert) {
        // Only clear values we wrote — never wipe a user's custom API base —
        // and put back the pre-install value when we know it.
        revertKey(config, "openAiBaseUrl", PROXY_BASE, original);
        revertKey(config, "openAIBaseUrl", PROXY_BASE, original);
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
    read: readJsonConfig,
    write: writeJsonConfig,
    configure: (config, revert, original) => {
      if (revert) {
        revertKey(config, "apiBaseUrl", PROXY_BASE, original);
        revertKey(config, "api_base_url", PROXY_BASE, original);
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
          const data = edit.parseJsonLoose(content);
          if (!edit.isPlainObject(data)) return null;
          return { type: "json", data, raw: content };
        }
        return { type: "yaml", data: null, raw: content };
      } catch { return null; }
    },
    write: (filePath, config) => {
      if (config.type === "json") writeJsonConfig(filePath, config.data);
      // YAML files are not auto-modified — we'll show instructions
    },
    configure: (config, revert, original) => {
      if (config.type !== "json") return config;
      const models = Array.isArray(config.data.models) ? config.data.models : [];
      if (revert) {
        if (!models.some((m) => m && m.apiBase === PROXY_BASE)) return config;
        config.data.models = models.filter((m) => !(m && m.apiBase === PROXY_BASE));
        if (!config.data.models.length && original && createdBySetup(original, "models")) {
          delete config.data.models;
        }
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
    read: readJsonConfig,
    write: writeJsonConfig,
    configure: (config, revert, original) => {
      if (revert) {
        const ours = revertKey(config, "openAiBaseUrl", PROXY_BASE, original);
        revertKey(config, "apiBaseUrl", PROXY_BASE, original);
        revertKey(config, "api_base_url", PROXY_BASE, original);
        // Setup also switched the provider; undo that only alongside our base
        // URL and only when the pre-install provider is known.
        if (ours && original) revertKey(config, "apiProvider", "openai-compatible", original);
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
    read: readJsonConfig,
    write: writeJsonConfig,
    configure: (config, revert, original) => {
      if (revert) {
        // Remove only our ANTHROPIC_BASE_URL override (restoring the user's
        // previous value when known); a value the user set stays.
        if (edit.isPlainObject(config.env)) {
          revertKey(config.env, "ANTHROPIC_BASE_URL", SC_ANTHROPIC_BASE, original && original.env);
          pruneEmpty(config, "env", original);
        }
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
    configure: (config, revert, original) => {
      if (config.type === "json") {
        const data = edit.parseJsonLoose(config.raw || "{}");
        if (revert) revertKey(data, "openai_base_url", PROXY_BASE, original ? edit.parseJsonLoose(original || "{}") : null);
        else data.openai_base_url = PROXY_BASE;
        return { ...config, raw: edit.rewriteJson(config.raw || "", data) };
      }

      const marker = "# SuperCompress Proxy";
      const line = `openai_base_url = \"${PROXY_BASE}\"`;
      let raw = config.raw || "";
      if (revert) {
        raw = raw.replace(new RegExp(`(^|\\n)\\n?${marker}\\n${line}(?:\\n|$)`, "g"), "$1");
        // Setup overwrote a pre-existing openai_base_url in place: put the
        // user's original line back (or drop ours if there was none).
        const cur = edit.findTomlKey(raw, null, "openai_base_url");
        if (cur && cur.value === `"${PROXY_BASE}"`) {
          const orig = original ? edit.findTomlKey(original, null, "openai_base_url") : null;
          raw = edit.replaceTomlLine(raw, cur.index, orig && orig.value !== cur.value ? orig.line : null);
        }
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

// Agents that get a first-class auto MCP/hooks plugin via `setup` / `plugin`.
const AUTO_MCP_AGENTS = new Set([
  "Cursor",
  "Windsurf",
  "Continue",
  "Cline",
  "Claude Code",
  "Codex",
  "Gemini CLI",
  "GitHub Copilot CLI",
  "VS Code Copilot",
  "Roo Code",
  "Kilo Code",
  "Kodu",
  "Goose",
  "OpenCode",
  "FreeBuff",
  "Pi",
  "Amp",
  "Zed",
  "Void",
  "PearAI",
  "Crush",
  "Mistral Vibe",
  "Claude Desktop",
  "Hermes",
  "OpenClaw",
  "Grok Build",
  "Grok Bot",
  "fx",
]);

// Broad detection catalog. These integrations are detected by an installed
// executable or a known local directory. AUTO_MCP_AGENTS get real auto-plugin
// writers; everything else still works via `agents connect` / base URL.
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
  ["Claude Desktop", ["claude-desktop"], ["Library/Application Support/Claude", "AppData/Roaming/Claude"]],
  ["Gemini Code Assist", ["gemini-code-assist"], [".gemini"]],
  ["Google Jules", ["jules"], [".jules"]],
  ["JetBrains AI", ["idea", "pycharm", "webstorm"], ["Library/Application Support/JetBrains"]],
  ["Composio", ["composio"], [".composio"]],
  ["Pythagora", ["pythagora"], [".pythagora"]],
  ["Marvin", ["marvin"], [".marvin"]],
  ["Hermes", ["hermes"], [".hermes"]],
  ["OpenClaw", ["openclaw", "claw"], [".openclaw"]],
  ["Grok Build", ["grok"], [".grok"]],
  // Marker dir under CONFIG_DIR is relative to HOME via detectAll special-case.
  ["Grok Bot", [], [".supercompress/hosts/grok-bot"]],
  ["fx", ["fx"], [".fx"]],
  ["Trae", ["trae"], [".trae"]],
  ["Antigravity", ["antigravity"], [".antigravity"]],
  ["Augment", ["augment"], [".augment"]],
  ["Factory Droid", ["droid"], [".factory", ".droid"]],
  ["Qwen Code", ["qwen"], [".qwen"]],
  ["Aide", ["aide"], [".aide"]],
  ["Bolt", ["bolt"], [".bolt"]],
].map(([name, commands, directories]) => ({
  name,
  commands,
  directories,
  autoMcp: AUTO_MCP_AGENTS.has(name),
  description: AUTO_MCP_AGENTS.has(name)
    ? `${name} MCP auto-plugin (setup/plugin)`
    : `${name} detected — use \`supercompress agents connect\` or its OpenAI/Anthropic base URL`,
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
  // First-class Grok Build description (auto MCP + hooks via setup/plugin)
  const grokHit = base.find((a) => a.name === "Grok Build");
  if (grokHit) {
    grokHit.description =
      "Grok Build MCP via ~/.grok/config.toml + hooks + ~/.grok/AGENTS.md (auto-configured by setup/plugin)";
    grokHit.autoMcp = true;
  }
  const grokBotHit = base.find((a) => a.name === "Grok Bot");
  if (grokBotHit) {
    grokBotHit.description =
      `Grok Bot hosted MCP ${HOSTED_MCP_URL} (cloud OAuth — auto-offered by setup/plugin)`;
    grokBotHit.autoMcp = true;
  }
  const fxHit = base.find((a) => a.name === "fx");
  if (fxHit) {
    fxHit.description =
      "fx (Vercel Labs) MCP via ~/.fx/mcp.json + ~/.fx/AGENTS.md + ~/.fx/skills/supercompress (auto-configured by setup/plugin)";
    fxHit.autoMcp = true;
  }
  for (const agent of base) {
    if (AUTO_MCP_AGENTS.has(agent.name)) agent.autoMcp = true;
  }
  return [...base, ...extras];
}

const AGENT_CATALOG = buildAgentCatalog();

/** Canonical MCP registration paths for doctor / health checks. */
function mcpPathMap() {
  return {
    Cursor: [path.join(HOME, ".cursor", "mcp.json")],
    "Claude Code": [
      path.join(HOME, ".claude.json"),
      path.join(HOME, ".claude", "settings.json"),
    ],
    Codex: [path.join(HOME, ".codex", "config.toml")],
    "Grok Build": [path.join(process.env.GROK_HOME || path.join(HOME, ".grok"), "config.toml")],
    "Grok Bot": [grokBotMcpPath()],
    fx: [path.join(HOME, ".fx", "mcp.json")],
    Hermes: [path.join(HOME, ".hermes", "config.yaml")],
    OpenClaw: [path.join(HOME, ".openclaw", "openclaw.json")],
    OpenCode: [
      path.join(HOME, ".config", "opencode", "opencode.json"),
      path.join(HOME, ".config", "opencode", "opencode.jsonc"),
    ],
    Continue: [path.join(HOME, ".continue", "config.json")],
    Windsurf: [
      path.join(HOME, ".codeium", "windsurf", "mcp_config.json"),
      path.join(HOME, ".windsurf", "mcp.json"),
    ],
    Zed: zedSettingsCandidates(),
    Goose: [path.join(HOME, ".config", "goose", "config.yaml")],
    "Gemini CLI": [path.join(HOME, ".gemini", "settings.json")],
    FreeBuff: [path.join(HOME, ".agents", "mcp.json")],
    Crush: [path.join(HOME, ".config", "crush", "mcp.json")],
    Amp: [path.join(HOME, ".amp", "mcp.json")],
    Pi: [path.join(HOME, ".pi", "mcp.json")],
    Void: [path.join(HOME, ".void", "mcp.json")],
    PearAI: [path.join(HOME, ".pearai", "mcp.json")],
    "Mistral Vibe": [path.join(HOME, ".vibe", "mcp.json")],
    "Kilo Code": [path.join(HOME, ".kilo", "mcp.json")],
    "Roo Code": [path.join(HOME, ".roo", "mcp.json")],
    Cline: [path.join(HOME, ".cline", "mcp.json")],
    "GitHub Copilot CLI": [path.join(HOME, ".copilot", "mcp.json")],
    "VS Code Copilot": [path.join(HOME, ".copilot", "mcp.json")],
    "Claude Desktop": [
      path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      path.join(HOME, "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
    ],
  };
}

function catalogStats() {
  const catalog = AGENT_CATALOG;
  const auto = catalog.filter((a) => a.autoMcp || AUTO_MCP_AGENTS.has(a.name));
  return {
    catalogued: catalog.length,
    autoMcp: auto.length,
    recipe: catalog.length - auto.length,
  };
}

const INSTALL_CHECKS = {
  Cursor: () => commandExists("cursor") || appExists("Cursor"),
  Windsurf: () => commandExists("windsurf") || appExists("Windsurf"),
  Continue: () => commandExists("code") && fs.existsSync(path.join(HOME, ".continue")),
  Cline: () => fs.existsSync(path.join(HOME, ".vscode", "extensions")) && fs.readdirSync(path.join(HOME, ".vscode", "extensions")).some((name) => name.startsWith("saoudrizwan.claude-dev-")),
  "Claude Code": () => commandExists("claude"),
  Aider: () => commandExists("aider"),
  Codex: () => commandExists("codex"),
  Zed: () => zedInstalled(),
  "Grok Build": () => grokInstalled(),
  "Grok Bot": () => grokBotAvailable(),
  fx: () => fxInstalled(),
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

/** True for the localhost proxy URLs SuperCompress writes into shell profiles. */
function isProxyEnvValue(value) {
  const v = String(value || "").trim().replace(/^["']|["']$/g, "");
  return /^https?:\/\/(?:localhost|127\.0\.0\.1):8080(?:\/v1)?\/?$/.test(v);
}

/**
 * Remove SuperCompress's proxy exports from the shell profile. A user's own
 * value for the same variable is kept; an original value setup overwrote is
 * put back when the pre-install profile is known.
 */
function revertShellProfile(original = null) {
  const profilePath = getShellProfile();
  try {
    if (!fs.existsSync(profilePath)) return false;
    const raw = fs.readFileSync(profilePath, "utf8");
    let content = raw;
    for (const varName of ["ANTHROPIC_BASE_URL", "OPENAI_API_BASE"]) {
      const origLine = original
        ? (original.match(new RegExp(`^export ${varName}=.*$`, "m")) || [null])[0]
        : null;
      const restore = origLine && !isProxyEnvValue(origLine.split("=").slice(1).join("="))
        ? origLine
        : null;
      content = content.replace(
        new RegExp(`^export ${varName}=(.*)$(\\n?)`, "gm"),
        (line, value, nl) => (isProxyEnvValue(value) ? (restore ? `${restore}${nl}` : "") : line)
      );
    }
    content = content.replace(/\n?(^|\n)# SuperCompress Proxy[ \t]*(?:\n|$)/g, "$1");
    if (content === raw) return false;
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
      : agent.name === "Grok Bot"
        ? grokBotAvailable()
      : Boolean(directory || command);
    if (installedExtra) {
      found.push({
        name: agent.name,
        configPath:
          agent.name === "Grok Bot"
            ? grokBotHome()
            : directory || (agent.name === "Zed" ? path.dirname(resolveZedSettingsPath()) : null),
        installed: true,
        autoConfigurable:
          agent.name === "Zed" ||
          agent.name === "Grok Bot" ||
          Boolean(agent.autoMcp) ||
          AUTO_MCP_AGENTS.has(agent.name),
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
        if (config == null) continue; // missing/malformed — never overwrite
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
 * @param {Set<string>} skip owned artifacts restoreOwnedArtifacts already
 *   returned to their pre-install contents. Deleting those would defeat the
 *   backup.
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
      const raw = fs.readFileSync(hooksPath, "utf8");
      const data = edit.parseJsonLoose(raw);
      const events = (edit.isPlainObject(data) && edit.isPlainObject(data.hooks)) ? data.hooks : {};
      if (pruneHookMap(events)) {
        if (Object.keys(events).length === 0) drop(hooksPath, "Cursor hooks.json");
        else {
          data.hooks = events;
          fs.writeFileSync(hooksPath, edit.rewriteJson(raw, data));
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
      const raw = fs.readFileSync(filePath, "utf8");
      const data = edit.parseJsonLoose(raw);
      if (!edit.isPlainObject(data) || !edit.isPlainObject(data.hooks)) continue;
      const events = data.hooks;
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
      fs.writeFileSync(filePath, edit.rewriteJson(raw, data));
      removed.push(`${name} hooks`);
    } catch (err) {
      console.error(`  ✗ Failed to clean ${filePath}: ${err.message}`);
    }
  }

  // Gemini CLI carries a flag rather than hooks.
  const geminiPath = path.join(HOME, ".gemini", "settings.json");
  if (fs.existsSync(geminiPath) && !skip.has(geminiPath)) {
    try {
      if (edit.editJsonFile(geminiPath, (data) => { delete data.supercompress; })) {
        removed.push("Gemini CLI flag");
      }
    } catch (err) {
      console.error(`  ✗ Failed to clean ${geminiPath}: ${err.message}`);
    }
  }

  // Legacy Grok path from 0.5.25 (Grok does not read ~/.grok/rules/).
  const grokLegacyRule = path.join(grokHome(), "rules", "supercompress.md");
  if (fs.existsSync(grokLegacyRule) && !skip.has(grokLegacyRule)) {
    drop(grokLegacyRule, "Grok Build legacy rules");
  }
  const grokSkillDir = path.join(grokHome(), "skills", "supercompress");
  if (fs.existsSync(grokSkillDir) && !skip.has(grokSkillDest()) && !skip.has(grokSkillDir)) {
    drop(grokSkillDir, "Grok Build skill");
  }
  const fxSkillDir = path.join(fxHome(), "skills", "supercompress");
  if (fs.existsSync(fxSkillDir) && !skip.has(fxSkillDir)) {
    drop(fxSkillDir, "fx skill");
  }

  // Always strip SuperCompress blocks. Instruction files are shared with the
  // user, so they are never rewound to a snapshot — only our block goes.
  for (const [name, filePath] of instructionTargets()) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const prev = fs.readFileSync(filePath, "utf8");
      const next = stripKnownInstructionBlocks(prev);
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
  // OpenClaw auto-compress copies skill/hooks/plugin outside the instruction file.
  removed.push(...removeOpenClawAutoCompressArtifacts());

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
      const before = fs.readFileSync(configPath, "utf8");
      // MCP entry first (it edits the file on disk), then the auto block — the
      // old code re-read the file afterwards and discarded these edits.
      if (typeof agentPlugins.removeHermesYaml === "function") {
        agentPlugins.removeHermesYaml(configPath);
      }
      const raw = fs.readFileSync(configPath, "utf8");
      const next = cleanHermesAutoConfig(raw, originalText(configPath));
      if (next !== raw) fs.writeFileSync(configPath, next);
      if (next !== before) removed.push("Hermes auto config");
    } catch (err) {
      console.error(`  ✗ Failed to clean Hermes config: ${err.message}`);
    }
  }

  // writeHermesAutoCompress appends a one-line nudge to SOUL.md.
  const soulPath = path.join(hermesHome, "SOUL.md");
  try {
    if (fs.existsSync(soulPath)) {
      const soul = fs.readFileSync(soulPath, "utf8");
      const next = soul.replace(
        /\n*When context dumps get large, prefer SuperCompress digests \(MCP compress_context \/ inbox\) over re-pasting raw tool output\.\n?/,
        "\n"
      );
      if (next !== soul) fs.writeFileSync(soulPath, next.trim() ? next : "");
    }
  } catch (err) {
    console.error(`  ✗ Failed to clean Hermes SOUL.md: ${err.message}`);
  }

  return removed;
}

const HERMES_COMPRESSION_BLOCK = [
  "compression:",
  "  enabled: true",
  "  threshold: 0.50",
  "  target_ratio: 0.20",
  "  protect_last_n: 20",
  "  in_place: true",
  "  proactive_prune_tokens: 48000",
  "  proactive_prune_min_result_chars: 4000",
].join("\n");

/**
 * Undo writeHermesAutoCompress in Hermes config.yaml: our hook entries and
 * marker, plus `hooks_auto_accept` / `compression` settings it introduced.
 * Settings are only reverted when the pre-install file is known and the value
 * is still exactly what setup wrote.
 */
function cleanHermesAutoConfig(raw, original) {
  let out = raw;
  out = out.replace(
    /(^|\n)([ \t]*)-[ \t]*command:[^\n]*(?:pre-llm-call|post-tool-call|agent-hooks\/supercompress)[^\n]*\n(?:\2[ \t]+[^\n]*\n)*/g,
    "$1"
  );
  out = out.replace(/^# supercompress-auto[^\n]*\n?/gm, "");
  // Hook events left with no entries.
  out = out.replace(/^( {2}[A-Za-z_][\w-]*):[ \t]*\n(?=(?: {2}\S|\S|$))/gm, (line, _k, offset) => {
    const head = out.slice(0, offset);
    const lastTop = head.match(/(?:^|\n)([A-Za-z_][\w-]*):[^\n]*\n(?:(?:[ \t][^\n]*|)\n)*$/);
    return lastTop && lastTop[1] === "hooks" ? "" : line;
  });
  out = edit.dropEmptyYamlKey(out, "hooks", original);

  if (original !== null && original !== undefined) {
    const origAccept = (original.match(/^hooks_auto_accept:[^\n]*/m) || [null])[0];
    if (/^hooks_auto_accept: true[ \t]*$/m.test(out) && origAccept !== "hooks_auto_accept: true") {
      out = origAccept
        ? out.replace(/^hooks_auto_accept: true[ \t]*$/m, origAccept)
        : edit.removeYamlTopLevelKey(out, "hooks_auto_accept");
    }
    if (!/^compression:/m.test(original)) {
      const block = edit.yamlTopLevelText(out, "compression");
      if (block && block.trim() === HERMES_COMPRESSION_BLOCK) {
        out = edit.removeYamlTopLevelKey(out, "compression");
      }
    } else if (!/proactive_prune_tokens:/.test(original)) {
      out = out.replace(/^ {2}proactive_prune_tokens: 48000\n {2}proactive_prune_min_result_chars: 4000\n/m, "");
    }
  }
  if (out !== raw && !out.endsWith("\n") && out) out += "\n";
  return out;
}

/** Drop OpenClaw skill / hooks / plugin written by writeOpenClawAutoCompress. */
function removeOpenClawAutoCompressArtifacts() {
  if (typeof agentPlugins.removeOpenClawAutoCompressArtifacts === "function") {
    return agentPlugins.removeOpenClawAutoCompressArtifacts();
  }
  return [];
}

/**
 * After the surgical removers ran, settle each shared file setup touched:
 * - created by setup and now empty → delete it again;
 * - equal to its pre-install snapshot except for formatting → write the
 *   snapshot bytes back (nothing the user added can be lost that way).
 * Anything else the user changed since install is left exactly as it is.
 */
function finalizeSharedConfigs(backups) {
  for (const [filePath, snapshot] of Object.entries(backups)) {
    if (!snapshot || isOwnedArtifact(filePath)) continue;
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
      const raw = fs.readFileSync(filePath, "utf8");
      if (!snapshot.exists) {
        if (isEffectivelyEmpty(filePath, raw)) fs.unlinkSync(filePath);
        continue;
      }
      const before = typeof snapshot.content === "string" ? snapshot.content : null;
      if (before !== null && raw !== before && sameContent(filePath, raw, before)) {
        fs.writeFileSync(filePath, before);
      }
    } catch (err) {
      console.error(`  ✗ Failed to finalize ${filePath}: ${err.message}`);
    }
  }
}

function looksJson(filePath) {
  return /\.jsonc?$/i.test(filePath);
}

function isEffectivelyEmpty(filePath, raw) {
  if (!raw.trim()) return true;
  if (!looksJson(filePath)) return false;
  try {
    const data = edit.parseJsonLoose(raw);
    return edit.isPlainObject(data) && Object.keys(data).length === 0 && edit.jsonComments(raw).length === 0;
  } catch {
    return false;
  }
}

function sameContent(filePath, a, b) {
  if (looksJson(filePath)) {
    try {
      if (!edit.deepEqual(edit.parseJsonLoose(a), edit.parseJsonLoose(b))) return false;
      const kept = new Set(edit.jsonComments(b));
      return edit.jsonComments(a).every((c) => kept.has(c));
    } catch {
      // fall through to a text comparison
    }
  }
  return edit.normalizeText(a) === edit.normalizeText(b);
}

/**
 * Undo everything SuperCompress set up, touching only what it added.
 * Returns human-readable labels for what was reverted/removed.
 */
function revertAll() {
  const backups = loadBackups();
  activeBackups = backups;
  try {
    const reverted = [];
    const restored = restoreOwnedArtifacts(backups);

    for (const agent of AGENTS) {
      const filePath = agent.detect();
      if (!filePath) continue;
      try {
        const config = agent.read(filePath);
        if (config == null) continue; // missing/malformed — leave it alone
        const before = JSON.stringify(config);
        const text = originalText(filePath, backups);
        const original = agent.name === "Codex" ? text : originalJson(filePath, backups);
        const updated = agent.configure(config, true, original);
        if (updated && JSON.stringify(updated) !== before) {
          agent.write(filePath, updated);
          reverted.push(`Reverted ${agent.name}`);
        }
      } catch (err) {
        console.error(`  ✗ Failed to revert ${agent.name}: ${err.message}`);
      }
    }

    revertShellProfile(originalText(getShellProfile(), backups));

    // Skip only owned artifacts restored above — a user's own file at one of
    // our paths must not be restored and then deleted.
    reverted.push(...removePluginArtifacts(restored).map((a) => `Removed ${a}`));
    reverted.push(...removeMcp().map((a) => `Removed ${a.replace(/ MCP$/, "")} MCP registration`));
    finalizeSharedConfigs(backups);
    try { fs.unlinkSync(BACKUP_PATH); } catch {}
    return reverted;
  } finally {
    activeBackups = null;
  }
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
      if (config == null) continue;
      const before = JSON.stringify(config);
      const updated = agent.configure(config, true, null);
      if (updated && JSON.stringify(updated) !== before) {
        agent.write(filePath, updated);
        cleared.push(agent.name);
      }
    } catch (err) {
      console.error(`  ✗ Failed to clear proxy override for ${agent.name}: ${err.message}`);
    }
  }
  revertShellProfile(null);

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

${guidance.COMPRESS_INTRO}

${guidance.COMPRESS_WHAT.join("\n")}

## Every time context gets large

${guidance.compressSteps(inboxPath).join("\n")}

Hooks also auto-compress large tool outputs (\`postToolUse\`), so a digest may already be waiting in the inbox.

## Rate limits

${guidance.runwayRule().replace(/^\*\*Rate limits:\*\* /, "")}

## Defaults

- Keep Cursor login — never switch to provider API-key mode for SuperCompress
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
  backupFile(path.join(hooksDir, "..", "mcp-response.js"));
  fs.copyFileSync(path.join(__dirname, "mcp-response.js"), path.join(hooksDir, "..", "mcp-response.js"));

  const srcDir = path.join(__dirname, "cursor-hooks");
  const scripts = [
    "session-start.js",
    "post-tool-compress.js",
    "before-submit.js",
    "user-prompt-submit.js",
    "compress-prompt-lib.js",
    "grok-post-tool.js",
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
  backupFile(path.join(hooksDir, "..", "mcp-response.js"));
  fs.copyFileSync(path.join(__dirname, "mcp-response.js"), path.join(hooksDir, "..", "mcp-response.js"));
  const srcDir = path.join(__dirname, "cursor-hooks");
  for (const name of [
    "session-start.js",
    "post-tool-compress.js",
    "before-submit.js",
    "user-prompt-submit.js",
    "compress-prompt-lib.js",
    "grok-post-tool.js",
  ]) {
    const src = path.join(srcDir, name);
    const dest = path.join(hooksDir, name);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, dest);
    try { fs.chmodSync(dest, 0o755); } catch {}
  }
  return hooksDir;
}

function upsertClaudeStyleHook(data, eventName, command, matcher, extra = {}) {
  data.hooks = data.hooks || {};
  const groups = Array.isArray(data.hooks[eventName]) ? data.hooks[eventName] : [];
  const filtered = groups.filter((g) => {
    const hooks = (g && g.hooks) || [];
    return !hooks.some((h) => isSuperCompressCommand(h && h.command));
  });
  const hook = { type: "command", command, timeout: extra.timeout || 20 };
  if (extra.env && typeof extra.env === "object") hook.env = extra.env;
  const entry = { hooks: [hook] };
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

  // Grok Build — ~/.grok/hooks/*.json (always trusted). Use env{}, not a
  // VAR=value command prefix — Grok may exec the first token, not a shell.
  if (grokInstalled()) {
    try {
      const grokHooksPath = path.join(grokHome(), "hooks", "supercompress.json");
      fs.mkdirSync(path.dirname(grokHooksPath), { recursive: true });
      backupFile(grokHooksPath);
      const data = { hooks: {} };
      const grokEnv = { SUPERCOMPRESS_AGENT_NAME: "Grok Build" };
      upsertClaudeStyleHook(data, "UserPromptSubmit", promptCmd, null, {
        timeout: 60,
        env: grokEnv,
      });
      upsertClaudeStyleHook(data, "PostToolUse", postCmd, ".*", {
        timeout: 60,
        env: grokEnv,
      });
      fs.writeFileSync(grokHooksPath, `${JSON.stringify(data, null, 2)}\n`);
      installed.push("Grok Build");
    } catch (err) {
      console.error(`  ⚠ Grok Build hooks: ${err.message}`);
    }
  }

  return { cmd: promptCmd, postCmd, installed };
}

/**
 * Always-on instruction files so agents that lack hooks still prefer compress_context.
 */
function genericInstructionBody(inboxPath) {
  return [
    "# SuperCompress (always on · context only)",
    "",
    guidance.COMPRESS_INTRO,
    "",
    ...guidance.COMPRESS_WHAT,
    "",
    ...guidance.compressSteps(inboxPath),
    "5. " + guidance.runwayRule(),
    "",
  ].join("\n");
}

/**
 * Remove the exact instruction blocks this version writes (some contain "##"
 * sub-sections the heading-based stripper would stop at), then fall back to
 * the heading match for older variants.
 */
function stripKnownInstructionBlocks(text) {
  const inboxPath = path.join(HOME, ".supercompress", "inbox", "latest.md");
  const blocks = [
    grokInstructionBody(inboxPath),
    fxInstructionBody(inboxPath),
    genericInstructionBody(inboxPath),
  ];
  try {
    if (typeof agentPlugins.instructionBody === "function") blocks.push(agentPlugins.instructionBody());
  } catch {}
  let out = text;
  for (const block of blocks) {
    const needle = String(block || "").trim();
    if (!needle) continue;
    let idx;
    while ((idx = out.indexOf(needle)) >= 0) {
      out = `${out.slice(0, idx).replace(/\n+$/, "\n")}\n${out.slice(idx + needle.length).replace(/^\n+/, "")}`;
    }
  }
  if (out !== text) {
    out = out.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n+$/, "\n");
    if (!out.trim()) out = "";
  }
  return stripInstructionBlock(out);
}

function writeAgentInstructionFiles() {
  const written = [];
  const inboxPath = path.join(HOME, ".supercompress", "inbox", "latest.md");
  const body = genericInstructionBody(inboxPath);

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
        (name === "OpenClaw" && (commandExists("openclaw") || commandExists("claw") || fs.existsSync(path.join(HOME, ".openclaw")))) ||
        (name === "Grok Build" && grokInstalled()) ||
        (name === "fx" && fxInstalled());
      if (!existsAgent) continue;

      fs.mkdirSync(dir, { recursive: true });
      backupFile(filePath);
      const block =
        name === "Grok Build"
          ? grokInstructionBody(inboxPath)
          : name === "fx"
            ? fxInstructionBody(inboxPath)
            : body;
      let next = block;
      if (name === "Grok Build") {
        try { writeGrokSkill(); } catch (err) {
          console.error(`  ⚠ Grok Build skill: ${err.message}`);
        }
        const legacyRule = path.join(grokHome(), "rules", "supercompress.md");
        if (fs.existsSync(legacyRule)) {
          try { fs.unlinkSync(legacyRule); } catch {}
        }
      }
      if (name === "fx") {
        try { writeFxSkill(); } catch (err) {
          console.error(`  ⚠ fx skill: ${err.message}`);
        }
      }
      if (fs.existsSync(filePath)) {
        const prev = fs.readFileSync(filePath, "utf8");
        if (/SuperCompress \(always on/i.test(prev)) {
          next = prev.replace(
            /# SuperCompress \(always on[^\n]*\)[\s\S]*?(?=\n# (?!#)|\n*$)/,
            block.trim() + "\n\n"
          );
          // If the heading variant didn't match the regex, avoid appending a duplicate.
          if (next === prev) {
            next = prev; // already present under a recognized heading
          }
        } else {
          next = `${prev.trimEnd()}\n\n${block}`;
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
/**
 * Runway (local rate-limit checks) ships inside this package. Copy its
 * runtime to ~/.supercompress/runway/ and, for Claude Code, tee the
 * statusline's rate_limits into the local cache. Codex needs no wiring;
 * proxied harnesses are captured from response headers.
 */
function installRunway() {
  const result = { runtime: null, claude: null };
  try {
    result.runtime = require("./limits/cli").installRuntime();
  } catch (err) {
    console.error(`  ⚠ Runway runtime: ${err.message}`);
    return result;
  }
  if (require("./limits").disabled()) return result;
  if (commandExists("claude") || fs.existsSync(path.join(HOME, ".claude"))) {
    try {
      result.claude = require("./limits/cli").connectClaude().status;
    } catch (err) {
      console.error(`  ⚠ Runway (Claude Code statusline): ${err.message}`);
    }
  }
  return result;
}

function installAutoPlugin() {
  const found = detectAll();
  const mcpConfigured = configureMcp();
  const rulePath = writeCursorRule();
  const hooks = writeCursorHooks();
  const agentHooks = writeAgentPromptHooks();
  const instructions = writeAgentInstructionFiles();
  const runway = installRunway();
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
  let openclaw = null;
  if (
    commandExists("openclaw") ||
    commandExists("claw") ||
    fs.existsSync(path.join(HOME, ".openclaw"))
  ) {
    try {
      const openclawHome = path.join(HOME, ".openclaw");
      backupFile(path.join(openclawHome, "AGENTS.md"));
      backupFile(path.join(openclawHome, "openclaw.json"));
      openclaw = agentPlugins.writeOpenClawAutoCompress(openclawHome);
    } catch (err) {
      console.error(`  ⚠ OpenClaw auto-compress: ${err.message}`);
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
    runway,
    hermes,
    openclaw,
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
  AUTO_MCP_AGENTS,
  catalogStats,
  mcpPathMap,
  writeGooseYaml,
  writeContinueMcp,
  writeCursorRule,
  writeCursorHooks,
  writeAgentPromptHooks,
  writeAgentInstructionFiles,
  installAutoPlugin,
  installRunway,
  agentPlugins,
  resolveExtensionMcpTargets,
};
