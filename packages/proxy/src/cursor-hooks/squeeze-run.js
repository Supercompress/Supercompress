#!/usr/bin/env node
"use strict";
/**
 * Reads a shell command's combined output on stdin, squeezes it locally and
 * prints what the agent should see. The pre-tool hook pipes commands into this.
 *
 * - The raw output is always saved under ~/.supercompress/outputs; the footer
 *   names the file so the agent can grep or sed it for anything omitted.
 * - The wrapped command reports its exit status as a final `__SC_EXIT=<n>` line;
 *   this process exits with that status so the agent sees the real result.
 * - Each applied squeeze appends one line to ~/.supercompress/savings.jsonl
 *   (token counts and the command's first word only, never the output).
 * - Fail-open: on any internal error the raw output is printed unchanged.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

let squeezeLib;
for (const candidate of ["./squeeze.js", "../squeeze.js"]) {
  try {
    squeezeLib = require(path.join(__dirname, candidate));
    break;
  } catch {}
}

const EXIT_RE = /\n?__SC_EXIT=(\d+)\s*$/;
const MAX_KEEP_FILES = 200;
const configDir = process.env.SUPERCOMPRESS_CONFIG_DIR || path.join(os.homedir(), ".supercompress");
const label = String(process.env.SUPERCOMPRESS_CMD || process.argv[2] || "").slice(0, 40);
const agent = process.env.SUPERCOMPRESS_AGENT_NAME || "Claude Code";

const chunks = [];
let finished = false;

function pruneOutputs(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".log")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - MAX_KEEP_FILES))) fs.unlinkSync(path.join(dir, f));
  } catch {}
}

function finish(interrupted) {
  if (finished) return;
  finished = true;
  let raw = Buffer.concat(chunks).toString("utf8");
  // No marker means a plain pipe (permission-checked mode): the command's own
  // status cannot reach us, so exit 0 and say so instead of inventing one.
  let code = interrupted ? 143 : 0;
  const m = raw.match(EXIT_RE);
  const statusKnown = Boolean(m);
  if (m) {
    code = Number(m[1]);
    raw = raw.slice(0, m.index);
  }
  const statusNote = statusKnown || interrupted ? "" : " Exit status not visible through this pipe; judge success from the output.";
  let shown = raw;
  try {
    if (!squeezeLib) throw new Error("squeeze unavailable");
    const r = squeezeLib.squeeze(raw);
    if (r.applied) {
      const dir = path.join(configDir, "outputs");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.log`);
      fs.writeFileSync(file, raw, { mode: 0o600 });
      pruneOutputs(dir);
      shown =
        `${r.text}\n` +
        `[supercompress: ${r.original_tokens}→${r.kept_tokens} tokens, ${r.omitted_lines} repeated lines omitted. ` +
        `Full output: ${file} (grep or sed it if you need an omitted line).${statusNote}]`;
      try {
        fs.appendFileSync(
          path.join(configDir, "savings.jsonl"),
          JSON.stringify({
            ts: new Date().toISOString(),
            agent,
            cmd: label.split(/\s+/)[0] || "",
            original_tokens: r.original_tokens,
            kept_tokens: r.kept_tokens,
            applied: true,
            source: "pre-tool-squeeze",
          }) + "\n"
        );
      } catch {}
    }
    else if (statusNote) shown = `${raw}${raw.endsWith("\n") || !raw ? "" : "\n"}[supercompress:${statusNote}]`;
  } catch {
    shown = raw;
  }
  process.stdout.write(shown.endsWith("\n") || !shown ? shown : `${shown}\n`, () => process.exit(code));
}

process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => finish(false));
process.stdin.on("error", () => finish(false));
// On a timeout kill, still show what ran so far instead of nothing.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => finish(true));
