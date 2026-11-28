"use strict";
/**
 * Command-output squeezer for coding agents.
 *
 * Runs locally on the output of a shell command before the agent sees it.
 * Deterministic and conservative:
 *  - strips ANSI escapes and carriage-return progress redraws
 *  - collapses lines that repeat one template (digits/hex/ids normalised) many times,
 *    keeping the first and last occurrences and a marker with the omitted count
 *  - never drops a line that looks like an error, failure or warning, nor the
 *    lines right after one (stack frames, assertion diffs)
 *  - always keeps the first and last lines (headers, summaries, exit status)
 *  - passes small outputs through unchanged
 * The caller saves the raw output so nothing is lost: the footer names the file.
 */

const MIN_CHARS = Number(process.env.SUPERCOMPRESS_SQUEEZE_MIN_CHARS || 6000);
const MIN_SAVINGS = 0.25; // apply only when at least a quarter of the tokens go
const KEEP_HEAD = 8;
const KEEP_TAIL = 12;
const REPEAT_MIN = 6; // a template must occur this often before it is collapsed
const KEEP_FIRST = 3;
const KEEP_LAST = 1;
const AFTER_SIGNAL = 12; // lines kept after an error-like line
const BEFORE_SIGNAL = 2;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const SIGNAL =
  /\b(?:err(?:or|!)?|fail(?:ed|ure|ing|s)?|fatal|panic(?:ked)?|exception|traceback|warn(?:ing)?|denied|refused|unable|cannot|can't|couldn't|invalid|undefined|not found|no such|assert(?:ion)?|expected|received|timed? ?out|segfault|abort(?:ed)?|killed|exit (?:code|status)|errno|E[A-Z]{3,})\b|[✕✗✘×]|^\s*FAIL\b|^\s*-{2,}\s*FAIL/i;
const TEMPLATE_SUBS = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>"],
  [/\b[0-9a-f]{7,64}\b/gi, "<hex>"],
  [/\d+(?:[.,:]\d+)*/g, "#"],
  [/\s+/g, " "],
];

function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

function clean(text) {
  return String(text || "")
    .replace(ANSI, "")
    .split("\n")
    .map((line) => {
      // Progress bars redraw with \r: only the final frame was ever visible.
      const cr = line.lastIndexOf("\r", line.length - 2);
      return (cr >= 0 ? line.slice(cr + 1) : line).replace(/\r$/, "");
    });
}

function templateOf(line) {
  let t = line.trim();
  for (const [re, sub] of TEMPLATE_SUBS) t = t.replace(re, sub);
  return t;
}

function squeeze(raw, options = {}) {
  const original = String(raw || "");
  const minChars = options.minChars ?? MIN_CHARS;
  const base = { applied: false, original_tokens: estimateTokens(original) };
  if (original.length < minChars) return { ...base, text: original, kept_tokens: base.original_tokens, reason: "below_min_size" };

  const lines = clean(original);
  const n = lines.length;
  const protect = new Uint8Array(n);
  for (let i = 0; i < Math.min(KEEP_HEAD, n); i++) protect[i] = 1;
  for (let i = Math.max(0, n - KEEP_TAIL); i < n; i++) protect[i] = 1;
  for (let i = 0; i < n; i++) {
    if (!SIGNAL.test(lines[i])) continue;
    for (let j = Math.max(0, i - BEFORE_SIGNAL); j <= Math.min(n - 1, i + AFTER_SIGNAL); j++) protect[j] = 1;
  }

  // Count templates over unprotected, non-blank lines.
  const templates = new Array(n);
  const counts = new Map();
  for (let i = 0; i < n; i++) {
    if (protect[i] || !lines[i].trim()) continue;
    const t = templateOf(lines[i]);
    templates[i] = t;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  const seen = new Map();
  const drop = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const t = templates[i];
    if (t === undefined) continue;
    const total = counts.get(t);
    if (total < REPEAT_MIN) continue;
    const k = (seen.get(t) || 0) + 1;
    seen.set(t, k);
    if (k > KEEP_FIRST && k <= total - KEEP_LAST) drop[i] = 1;
  }

  // Also collapse runs of blank lines to one.
  for (let i = 1; i < n; i++) if (!protect[i] && !lines[i].trim() && !lines[i - 1].trim()) drop[i] = 1;

  const out = [];
  let omitted = 0;
  let i = 0;
  while (i < n) {
    if (!drop[i]) {
      out.push(lines[i]);
      i++;
      continue;
    }
    let j = i;
    const run = new Map();
    while (j < n && drop[j]) {
      if (templates[j] !== undefined) run.set(templates[j], (run.get(templates[j]) || 0) + 1);
      j++;
    }
    const count = j - i;
    omitted += count;
    const top = [...run.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) out.push(`… [${count} similar line${count === 1 ? "" : "s"} omitted, e.g. ${top[0].slice(0, 100)}]`);
    i = j;
  }

  const text = out.join("\n");
  const keptTokens = estimateTokens(text);
  if (keptTokens > base.original_tokens * (1 - MIN_SAVINGS)) {
    return { ...base, text: original, kept_tokens: base.original_tokens, reason: "no_savings" };
  }
  return { applied: true, text, original_tokens: base.original_tokens, kept_tokens: keptTokens, omitted_lines: omitted, reason: "repeats_collapsed" };
}

module.exports = { squeeze, estimateTokens, templateOf, SIGNAL };
