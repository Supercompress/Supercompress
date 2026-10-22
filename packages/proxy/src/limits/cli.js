/**
 * `supercompress limits …` — agent-facing runway command.
 *
 *   limits [status] [--json] [--provider <p>] [--policy max|balanced|conservative]
 *                   [--file <path>] [--json-input <json>]
 *   limits ingest   [--provider <p>] [--passthrough]   read usage JSON on stdin
 *   limits statusline                                 Claude Code statusline: ingest + print one line
 *   limits connect  claude-code                       tee Claude Code statusline rate_limits into the cache
 *   limits disconnect claude-code
 *
 * stdout carries exactly one JSON line with --json; errors go to stderr with
 * exit code 2 (same contract as limitcheck).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const limits = require("./index");
const store = require("./store");

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const value = args[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

async function readStdin() {
  if (process.stdin.isTTY) return null;
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value.trim() ? value : null;
}

function claudeSettingsPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(dir, "settings.json");
}

function connectionRecordPath() {
  return path.join(store.limitsDir(), "claude-statusline.json");
}

// The statusline must not depend on an npx cache or a global bin that can
// disappear, so setup copies these modules to ~/.supercompress/runway/ and
// the statusline runs that copy.
const RUNTIME_FILES = ["cli.js", "headers.js", "index.js", "normalize.js", "runway.js", "sources.js", "store.js", "run.js"];
const TEE_ARGS = "ingest --provider claude-code --passthrough";
const LEGACY_MARK = "limits ingest --provider claude-code --passthrough";

function runtimeDir() {
  return path.join(path.dirname(store.limitsDir()), "runway");
}

function installRuntime() {
  const dir = runtimeDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of RUNTIME_FILES) {
    const src = path.join(__dirname, name);
    const dest = path.join(dir, name);
    if (path.resolve(src) === path.resolve(dest)) continue;
    fs.copyFileSync(src, dest);
  }
  return dir;
}

function nodeCommand() {
  try {
    execFileSync("which", ["node"], { stdio: "ignore" });
    return "node";
  } catch {
    return JSON.stringify(process.execPath);
  }
}

function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Pins the config dir so the statusline writes the same cache the MCP server reads. */
function runtimeCommand() {
  const configDir = path.dirname(store.limitsDir());
  return `SUPERCOMPRESS_CONFIG_DIR=${shq(configDir)} ${nodeCommand()} ${shq(path.join(runtimeDir(), "run.js"))}`;
}

/**
 * `(tee || cat) | ( original )` — the subshell keeps compound statuslines
 * (`cd x && node y`) whole, and if the runtime is ever missing, stdin still
 * reaches the user's statusline.
 */
function wrapStatusline(original) {
  return `(${runtimeCommand()} ${TEE_ARGS} 2>/dev/null || cat) | ( ${original}\n)`;
}

const WRAPPED_RE = /^\(.*? ingest --provider claude-code --passthrough 2>\/dev\/null \|\| cat\) \| \( ([\s\S]*)\n\)$/;

function isOurs(command) {
  return typeof command === "string" && (command.includes(TEE_ARGS) || /(?:limits|run\.js['"]?) statusline/.test(command));
}

function connectClaude() {
  const file = claudeSettingsPath();
  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`${file} is not valid JSON; not touching it (${err.message})`);
    }
  }
  const current = settings.statusLine;
  if (current && isOurs(current.command)) {
    return { status: "unchanged", path: file };
  }
  installRuntime();
  fs.mkdirSync(path.dirname(connectionRecordPath()), { recursive: true });
  fs.writeFileSync(connectionRecordPath(), JSON.stringify({ original: current ?? null, connectedAt: new Date().toISOString() }, null, 2) + "\n");
  settings.statusLine =
    current && current.type === "command" && current.command
      ? { ...current, command: wrapStatusline(current.command) }
      : { type: "command", command: `${runtimeCommand()} statusline 2>/dev/null || true`, padding: 0 };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return { status: "connected", path: file, wrapped: Boolean(current && current.command) };
}

function disconnectClaude() {
  const file = claudeSettingsPath();
  if (!fs.existsSync(file)) return { status: "absent", path: file };
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { status: "skipped", path: file };
  }
  const current = settings.statusLine;
  if (!current || typeof current.command !== "string") return { status: "unchanged", path: file };
  let record = null;
  try {
    record = JSON.parse(fs.readFileSync(connectionRecordPath(), "utf8"));
  } catch {}
  const wrapped = current.command.match(WRAPPED_RE);
  if (wrapped) {
    // Unwrap in place so later edits to the wrapped command survive.
    settings.statusLine = { ...current, command: wrapped[1] };
  } else if (current.command.includes(LEGACY_MARK)) {
    const inner = current.command.slice(current.command.indexOf(LEGACY_MARK) + LEGACY_MARK.length).replace(/^\s*\|\s*/, "");
    settings.statusLine = { ...current, command: inner };
  } else if (isOurs(current.command)) {
    if (record && record.original) settings.statusLine = record.original;
    else delete settings.statusLine;
  } else {
    return { status: "unchanged", path: file };
  }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  try {
    fs.unlinkSync(connectionRecordPath());
  } catch {}
  return { status: "disconnected", path: file };
}

function statusLineText(snapshot) {
  const parts = snapshot.windows
    .filter((w) => !/\/ min$/.test(w.name))
    .map((w) => `${w.name.replace(" window", "")} ${Math.round(w.remainingPercent)}%`);
  return parts.length ? `runway ${parts.join(" · ")}` : "";
}

async function run(args) {
  const sub = args[0] && !args[0].startsWith("-") ? args.shift() : "status";
  const provider = flag(args, "--provider");

  if (sub === "ingest" || sub === "statusline") {
    const passthrough = sub === "ingest" && args.includes("--passthrough");
    const raw = await readStdin();
    let snapshot = null;
    try {
      if (raw) snapshot = limits.ingest(raw, provider ?? (sub === "statusline" ? "claude-code" : undefined));
    } catch (err) {
      // A statusline tee must never break the user's statusline.
      if (!passthrough && sub !== "statusline") throw err;
    }
    if (passthrough) {
      if (raw) process.stdout.write(raw);
    } else if (sub === "statusline") {
      process.stdout.write(snapshot ? statusLineText(snapshot) : "runway: waiting for first reply");
    } else {
      if (!snapshot) throw new Error("No usage JSON on stdin. Pipe a payload, e.g. `echo '{...}' | supercompress limits ingest`.");
      process.stdout.write(`${JSON.stringify({ ok: true, provider: snapshot.provider, windows: snapshot.windows.length })}\n`);
    }
    return;
  }

  if (sub === "connect" || sub === "disconnect") {
    const target = args.find((a) => !a.startsWith("-")) ?? "claude-code";
    if (!/^claude/.test(target)) {
      throw new Error(`connect supports claude-code. Other harnesses: pipe usage JSON to \`supercompress limits ingest --provider ${target}\`, or route them through the local proxy.`);
    }
    const result = sub === "connect" ? connectClaude() : disconnectClaude();
    process.stdout.write(`runway: ${result.status} ${result.path}\n`);
    return;
  }

  if (sub !== "status") throw new Error(`Unknown limits command: ${sub}`);

  const file = flag(args, "--file");
  const inline = flag(args, "--json-input");
  const policy = flag(args, "--policy") ?? undefined;
  const raw = file ? fs.readFileSync(file, "utf8") : inline ?? (args.includes("--stdin") ? await readStdin() : null);
  const result = limits.status({ provider: provider ?? undefined, raw: raw ?? undefined, policy });
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(`${limits.formatText(result)}\n`);
  }
}

module.exports = { run, connectClaude, disconnectClaude, statusLineText, installRuntime, runtimeDir };
