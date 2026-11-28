#!/usr/bin/env node
"use strict";
/**
 * Claude Code PreToolUse hook (matcher: Bash).
 *
 * Rewrites a shell command so its output is squeezed locally *before* the
 * model sees it (squeeze-run.js). This is the path that actually removes
 * tokens: a PostToolUse hook can only add context next to the raw output.
 *
 * It never sets permissionDecision, so the user's normal permission rules
 * still apply to the call. It leaves alone anything that must run in the
 * agent's own shell (cd, export, source…), background or interactive
 * commands, and commands whose exact bytes matter (cat, sed, git diff…).
 * Fail-open: any error means no rewrite.
 */
const path = require("path");

const RUNNER = path.join(__dirname, "squeeze-run.js");
const SEP = String.raw`(?:^|[;&|(\n]\s*|\$\(\s*|\x60\s*)`;
const STATEFUL = new RegExp(
  `${SEP}(?:cd|pushd|popd|export|source|\\.|alias|unalias|unset|set|setopt|unsetopt|shopt|ulimit|umask|eval|exec|declare|typeset|local|readonly|trap|history|fg|bg|jobs|wait|disown|nohup|setsid)(?=\\s|$)`
);
const INTERACTIVE = new RegExp(
  `${SEP}(?:vim?|nvim|nano|emacs|less|more|man|top|htop|btop|watch|tmux|screen|ssh|telnet|ftp|sftp|claude|codex|gemini|fzf)(?=\\s|$)|\\btail\\s+(?:-\\S*f|--follow)|--watch\\b|\\s-i\\s*$`
);
const EXACT = new RegExp(
  `${SEP}(?:cat|bat|head|tail|sed|nl|diff|cmp|jq|yq|base64|xxd|od|hexdump|pbpaste|pbcopy|openssl|gpg|git\\s+(?:diff|show|format-patch|apply|cat-file|blame))(?=\\s|$)`
);

function shellQuote(s) {
  const str = String(s);
  // Bare when safe, so the permission rule setup writes matches the command text.
  if (/^[A-Za-z0-9_./@%+=:,-]+$/.test(str)) return str;
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

/** Allow rule setup adds so the runner half of a plain pipe never prompts. It only reads stdin. */
function runnerAllowRule(runner = RUNNER) {
  return `Bash(${shellQuote(runner)}:*)`;
}

function firstWord(cmd) {
  const m = String(cmd).trim().match(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*([A-Za-z0-9._/-]+)/);
  return m ? path.basename(m[1]).replace(/[^A-Za-z0-9._-]/g, "") : "";
}

function shouldWrap(input) {
  if (process.env.SUPERCOMPRESS_SQUEEZE === "0") return false;
  if (!input || typeof input.command !== "string") return false;
  if (input.run_in_background) return false;
  const cmd = input.command.trim();
  if (!cmd || cmd.length > 20000) return false;
  if (cmd.includes("squeeze-run.js") || /\bSC_RAW=1\b/.test(cmd)) return false;
  if (/&\s*$/.test(cmd) || /(^|[^&])&\s+[^&]/.test(cmd.replace(/[<>]&|&[<>]|&&|\d?>&\d/g, ""))) return false;
  if (STATEFUL.test(cmd) || INTERACTIVE.test(cmd) || EXACT.test(cmd)) return false;
  return true;
}

/**
 * Subshell + EXIT trap reports the command's own status (even after an explicit
 * `exit`) as the last line; the runner strips it and exits with it. The pipe's
 * status is the runner's, so no pipefail is needed in bash or zsh. The command
 * sits on its own lines so heredocs and trailing comments stay intact.
 */
function wrapCommand(cmd) {
  const label = firstWord(cmd);
  return (
    `( trap 'printf "\\n__SC_EXIT=%s\\n" "$?"' EXIT\n` +
    `${cmd}\n` +
    `) 2>&1 | ${shellQuote(RUNNER)} ${shellQuote(label)}`
  );
}

// Commands that are usually long and repetitive: the only ones worth wrapping when
// the user's permission rules check each call (see wrapPlain).
const NOISY = new RegExp(
  String.raw`^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:npx\s+|bunx\s+)?(?:` +
    String.raw`(?:npm|pnpm|yarn|bun)\s+(?:test|t|run|install|i|ci|add|build|exec)|` +
    String.raw`pytest|py\.test|tox|nox|jest|vitest|mocha|ava|playwright|cypress|tsc|eslint|ruff|mypy|pyright|` +
    String.raw`go\s+(?:test|build|vet|mod)|cargo\s+(?:test|build|check|clippy|run)|make|cmake|ninja|gradle|gradlew|\./gradlew|mvn|` +
    String.raw`pip3?\s+install|uv\s+(?:pip|sync|run)|poetry\s+(?:install|run)|bundle|rspec|rake|dotnet\s+(?:build|test)|swift\s+(?:build|test)|xcodebuild|` +
    String.raw`docker\s+(?:build|compose|logs)|kubectl\s+(?:logs|describe)|journalctl|find|du|ls\s+-\S*R` +
  String.raw`)(?=\s|$)`
);

/**
 * When permission rules apply, Claude Code refuses to pre-check groups, `set`,
 * variables and process substitution, so only a plain pipe is accepted. Its
 * status is the runner's, so the runner says the exit status is not visible.
 * Only single, known-noisy commands qualify.
 */
function wrapPlain(cmd) {
  return `${cmd.replace(/\s*2>&1\s*$/, "")} 2>&1 | ${shellQuote(RUNNER)}`;
}

function plainEligible(cmd) {
  const c = cmd.trim();
  if (/[;\n|`$(){}<>]|&&/.test(c.replace(/2>&1/g, ""))) return false;
  return NOISY.test(c);
}

function decide(payload) {
  const toolName = String(payload.tool_name || "");
  if (toolName !== "Bash") return null;
  const input = payload.tool_input || {};
  if (!shouldWrap(input)) return null;
  let command;
  if (payload.permission_mode === "bypassPermissions") command = wrapCommand(input.command);
  else if (plainEligible(input.command)) command = wrapPlain(input.command);
  else return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...input, command },
    },
  };
}

if (require.main === module) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    let out = null;
    try {
      out = decide(JSON.parse(raw || "{}"));
    } catch {}
    process.stdout.write(out ? JSON.stringify(out) : "{}");
  });
}

module.exports = { shouldWrap, wrapCommand, wrapPlain, plainEligible, decide, firstWord, runnerAllowRule, shellQuote, RUNNER };
