/**
 * Format-preserving config edits used by `supercompress uninstall`.
 *
 * Uninstall must remove only what SuperCompress added. Rewinding a whole file
 * to its install-time snapshot (or re-serializing it) destroys anything the
 * user changed afterwards: MCP servers added later, comments, formatting.
 * These helpers edit JSON/JSONC and TOML text in place so every byte we do not
 * own is left alone.
 */

"use strict";

// ── JSON / JSONC ─────────────────────────────────────────────────────────────

class UnsupportedEdit extends Error {}

/**
 * Parse JSON or JSONC (comments, trailing commas) into a span tree. Every node
 * carries `start`/`end` offsets and its decoded `value`. Throws on malformed
 * input, so callers never write anything derived from a bad parse.
 */
function scanJsonc(text) {
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const fail = (msg) => {
    throw new SyntaxError(`${msg} at offset ${i}`);
  };

  function skipWs() {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i += 1;
      if (text[i] === "/" && text[i + 1] === "/") {
        while (i < n && text[i] !== "\n") i += 1;
        continue;
      }
      if (text[i] === "/" && text[i + 1] === "*") {
        const close = text.indexOf("*/", i + 2);
        if (close < 0) fail("Unterminated comment");
        i = close + 2;
        continue;
      }
      return;
    }
  }

  function parseString() {
    const start = i;
    if (text[i] !== '"') fail("Expected string");
    i += 1;
    while (i < n) {
      const c = text[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') {
        i += 1;
        return { start, end: i, value: JSON.parse(text.slice(start, i)) };
      }
      if (c === "\n") fail("Unterminated string");
      i += 1;
    }
    return fail("Unterminated string");
  }

  function parseValue() {
    skipWs();
    const start = i;
    const c = text[i];
    if (c === "{") {
      i += 1;
      const members = [];
      const value = {};
      skipWs();
      while (text[i] !== "}") {
        if (i >= n) fail("Unterminated object");
        const key = parseString();
        skipWs();
        if (text[i] !== ":") fail("Expected ':'");
        i += 1;
        const node = parseValue();
        members.push({ key: key.value, start: key.start, end: node.end, node });
        Object.defineProperty(value, key.value, {
          value: node.value, enumerable: true, writable: true, configurable: true,
        });
        skipWs();
        if (text[i] === ",") {
          i += 1;
          skipWs();
          continue;
        }
        if (text[i] !== "}") fail("Expected ',' or '}'");
      }
      i += 1;
      return { type: "object", start, end: i, members, value };
    }
    if (c === "[") {
      i += 1;
      const items = [];
      skipWs();
      while (text[i] !== "]") {
        if (i >= n) fail("Unterminated array");
        const node = parseValue();
        items.push({ start: node.start, end: node.end, node });
        skipWs();
        if (text[i] === ",") {
          i += 1;
          skipWs();
          continue;
        }
        if (text[i] !== "]") fail("Expected ',' or ']'");
      }
      i += 1;
      return { type: "array", start, end: i, items, value: items.map((it) => it.node.value) };
    }
    if (c === '"') {
      const s = parseString();
      return { type: "string", start, end: s.end, value: s.value };
    }
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) fail("Unexpected token");
    i += m[0].length;
    return { type: "primitive", start, end: i, value: JSON.parse(m[0]) };
  }

  const root = parseValue();
  skipWs();
  if (i < n) fail("Unexpected trailing content");
  return root;
}

/** Parse JSON / JSONC text. Throws on malformed input. */
function parseJsonLoose(text) {
  return scanJsonc(String(text)).value;
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** Structural equality; object key order is ignored. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, idx) => deepEqual(v, b[idx]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function lineStartOf(text, pos) {
  return text.lastIndexOf("\n", pos - 1) + 1;
}

/** Offset of the first ',' after `pos`, skipping whitespace and comments. */
function commaAfter(text, pos) {
  let i = pos;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close < 0) return -1;
      i = close + 2;
      continue;
    }
    return text[i] === "," ? i : -1;
  }
}

/**
 * When an entry sits on its own line(s), return the offset just past the end
 * of its last line (after its comma / trailing comment) plus whether it had a
 * comma. Otherwise null.
 */
function ownLineTail(text, entry) {
  const ls = lineStartOf(text, entry.start);
  if (text.slice(ls, entry.start).trim() !== "") return null;
  const m = /^[ \t]*(,)?[ \t]*(?:\/\/[^\n]*)?\r?(?:\n|$)/.exec(text.slice(entry.end));
  if (!m) return null;
  return { lineStart: ls, tailEnd: entry.end + m[0].length, comma: Boolean(m[1]) };
}

/** Queue edits that delete the flagged entries of one object/array. */
function removeEntries(text, container, entries, removed, edits) {
  const n = entries.length;
  if (removed.every(Boolean)) {
    if (n) edits.push({ start: container.start + 1, end: container.end - 1, text: "" });
    return;
  }
  let k = 0;
  while (k < n) {
    if (!removed[k]) {
      k += 1;
      continue;
    }
    let b = k;
    while (b + 1 < n && removed[b + 1]) b += 1;
    const first = ownLineTail(text, entries[k]);
    const last = ownLineTail(text, entries[b]);
    if (first && last) {
      // Whole-line removal keeps neighbours' comments and indentation intact.
      edits.push({ start: first.lineStart, end: last.tailEnd, text: "" });
      if (b === n - 1 && !last.comma) {
        // The run was the tail: the previous entry's separator is now dangling.
        const comma = commaAfter(text, entries[k - 1].end);
        if (comma >= 0) edits.push({ start: comma, end: comma + 1, text: "" });
      }
    } else if (k > 0) {
      edits.push({ start: entries[k - 1].end, end: entries[b].end, text: "" });
    } else {
      edits.push({ start: entries[0].start, end: entries[b + 1].start, text: "" });
    }
    k = b + 1;
  }
}

function renderValue(text, pos, value) {
  const ls = lineStartOf(text, pos);
  const indent = (/^[ \t]*/.exec(text.slice(ls)) || [""])[0];
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
}

function collectEdits(text, node, next, edits) {
  if (deepEqual(node.value, next)) return;
  if (node.type === "object" && isPlainObject(next)) {
    const last = new Map();
    node.members.forEach((m, idx) => last.set(m.key, idx));
    for (const k of Object.keys(next)) {
      if (!last.has(k)) throw new UnsupportedEdit(`added key ${k}`);
    }
    const removed = node.members.map((m, idx) => {
      if (!Object.prototype.hasOwnProperty.call(next, m.key)) return true;
      if (last.get(m.key) === idx) collectEdits(text, m.node, next[m.key], edits);
      return false;
    });
    removeEntries(text, node, node.members, removed, edits);
    return;
  }
  if (node.type === "array" && Array.isArray(next)) {
    const old = node.value;
    const keep = [];
    let j = 0;
    for (let k = 0; k < old.length; k += 1) {
      if (j < next.length && deepEqual(old[k], next[j])) {
        keep.push(true);
        j += 1;
      } else keep.push(false);
    }
    if (j === next.length) {
      removeEntries(text, node, node.items, keep.map((x) => !x), edits);
      return;
    }
  }
  edits.push({ start: node.start, end: node.end, text: renderValue(text, node.start, next) });
}

/**
 * Return `raw` edited in place so it parses to `next`, touching only the
 * spans that changed (removed keys / array items, replaced values). Comments,
 * key order and formatting elsewhere survive. Returns null if `next` cannot be
 * reached by deletions/replacements alone or the result fails verification.
 */
function applyJsonDiff(raw, next) {
  try {
    const root = scanJsonc(raw);
    const edits = [];
    collectEdits(raw, root, next, edits);
    edits.sort((a, b) => b.start - a.start);
    let out = raw;
    let floor = Infinity;
    for (const e of edits) {
      if (e.end > floor) return null; // overlapping edits — bail out
      out = out.slice(0, e.start) + e.text + out.slice(e.end);
      floor = e.start;
    }
    return deepEqual(parseJsonLoose(out), next) ? out : null;
  } catch {
    return null;
  }
}

/** Serialize `next` for `raw`'s file, preserving formatting where possible. */
function rewriteJson(raw, next) {
  if (typeof raw === "string" && raw.trim()) {
    const edited = applyJsonDiff(raw, next);
    if (edited !== null) return edited;
  }
  return JSON.stringify(next, null, 2) + "\n";
}

// ── TOML ─────────────────────────────────────────────────────────────────────

function splitLines(text) {
  const parts = String(text).split(/(\r?\n)/);
  const lines = [];
  for (let k = 0; k < parts.length; k += 2) {
    lines.push({ text: parts[k], eol: parts[k + 1] || "" });
  }
  if (lines.length && lines[lines.length - 1].text === "" && lines[lines.length - 1].eol === "") {
    lines.pop();
  }
  return lines;
}

function joinLines(lines) {
  return lines.map((l) => l.text + l.eol).join("");
}

/** Normalize a TOML table name: `[ mcp_servers . "supercompress" ]` → `mcp_servers.supercompress`. */
function normalizeTomlName(raw) {
  const segs = [];
  let cur = "";
  let quote = null;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ".") {
      segs.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  segs.push(cur.trim());
  return segs.join(".");
}

/**
 * Classify TOML lines: table headers (outside multi-line strings/arrays),
 * the table each line belongs to, and whether it is blank / a comment.
 */
function parseTomlLines(text) {
  const lines = splitLines(text);
  let multi = null;
  let depth = 0;
  let table = null;
  for (const line of lines) {
    const t = line.text;
    line.header = null;
    line.blank = t.trim() === "";
    line.comment = /^\s*#/.test(t);
    if (!multi && depth === 0) {
      const h = /^\s*(\[\[?)\s*([^\[\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(t);
      if (h) {
        line.header = normalizeTomlName(h[2]);
        line.arrayTable = h[1] === "[[";
        table = line.header;
        line.table = table;
        continue;
      }
    }
    line.table = table;
    // Track multi-line strings and arrays so their lines are never mistaken
    // for headers.
    let k = 0;
    if (!multi && depth === 0) {
      const eq = t.indexOf("=");
      if (eq < 0 || line.comment) continue;
      k = eq + 1;
    }
    while (k < t.length) {
      if (multi) {
        const close = t.indexOf(multi, k);
        if (close < 0) break;
        k = close + 3;
        multi = null;
        continue;
      }
      const ch = t[k];
      if (ch === "#") break;
      if (t.startsWith('"""', k) || t.startsWith("'''", k)) {
        multi = t.slice(k, k + 3);
        k += 3;
        continue;
      }
      if (ch === '"' || ch === "'") {
        let e = k + 1;
        while (e < t.length && t[e] !== ch) e += ch === '"' && t[e] === "\\" ? 2 : 1;
        k = e + 1;
        continue;
      }
      if (ch === "[") depth += 1;
      else if (ch === "]") depth = Math.max(0, depth - 1);
      k += 1;
    }
  }
  return lines;
}

/**
 * Remove `[name]` and every `[name.*]` sub-table, leaving all other tables,
 * keys, comments and blank lines untouched. Comment lines directly above the
 * following table header are kept with that table. Returns the new text.
 */
function removeTomlTable(text, name) {
  const lines = parseTomlLines(text);
  const owns = (h) => h === name || h.startsWith(`${name}.`);
  const drop = new Array(lines.length).fill(false);
  let touchedEnd = false;
  for (let h = 0; h < lines.length; h += 1) {
    if (!lines[h].header || !owns(lines[h].header)) continue;
    let end = h + 1;
    while (end < lines.length && !lines[end].header) end += 1;
    let keepFrom = end;
    if (end < lines.length) {
      while (keepFrom - 1 > h && lines[keepFrom - 1].comment) keepFrom -= 1;
    } else {
      touchedEnd = true;
    }
    for (let k = h; k < keepFrom; k += 1) drop[k] = true;
  }
  if (!drop.some(Boolean)) return text;
  let kept = lines.filter((_, idx) => !drop[idx]);
  if (touchedEnd) {
    while (kept.length && kept[kept.length - 1].blank) kept.pop();
    if (kept.length) {
      const eol = (lines.find((l) => l.eol) || { eol: "\n" }).eol;
      kept[kept.length - 1] = { ...kept[kept.length - 1], eol };
    }
  }
  return joinLines(kept);
}

/** True when `[name]` (or a sub-table) is present. */
function hasTomlTable(text, name) {
  return parseTomlLines(text).some(
    (l) => l.header && (l.header === name || l.header.startsWith(`${name}.`))
  );
}

/** Find `key = …` in `table` (null = top level). Returns { index, line, value } or null. */
function findTomlKey(text, table, key) {
  const lines = parseTomlLines(text);
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.*?)\\s*(?:#.*)?$`);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const l = lines[idx];
    if (l.header || l.table !== table) continue;
    const m = re.exec(l.text);
    if (m) return { index: idx, line: l.text, value: m[1] };
  }
  return null;
}

/** Replace (newLine string) or delete (newLine null) line `index`. */
function replaceTomlLine(text, index, newLine) {
  const lines = splitLines(text);
  if (newLine === null) lines.splice(index, 1);
  else lines[index] = { ...lines[index], text: newLine };
  return joinLines(lines);
}

/** True when the exact table `[name]` is declared. */
function hasExactTomlTable(text, name) {
  return parseTomlLines(text).some((l) => l.header === name && !l.arrayTable);
}

/**
 * Drop the `[name]` header (only that header — never `[name.*]` sub-tables)
 * when its section holds nothing but blank lines.
 */
function dropEmptyTomlTable(text, name) {
  const lines = parseTomlLines(text);
  const h = lines.findIndex((l) => l.header === name && !l.arrayTable);
  if (h < 0) return text;
  let end = h + 1;
  while (end < lines.length && !lines[end].header) end += 1;
  if (!lines.slice(h + 1, end).every((l) => l.blank)) return text;
  let start = h;
  if (end >= lines.length) {
    while (start > 0 && lines[start - 1].blank) start -= 1;
  }
  const kept = lines.slice(0, start).concat(lines.slice(end));
  if (end >= lines.length && kept.length) {
    const eol = (lines.find((l) => l.eol) || { eol: "\n" }).eol;
    kept[kept.length - 1] = { ...kept[kept.length - 1], eol };
  }
  return joinLines(kept);
}

// ── YAML (top-level keys only) ───────────────────────────────────────────────

/**
 * When top-level `key:` has no children left, drop it (if the pre-install
 * file did not declare it) or put back its original one-line form. Returns
 * the new text.
 */
function dropEmptyYamlKey(text, key, originalText) {
  const lines = splitLines(text);
  const isHeader = (t) => new RegExp(`^${key}:[ \\t]*(?:#.*)?$`).test(t);
  const h = lines.findIndex((l) => isHeader(l.text));
  if (h < 0) return text;
  for (let k = h + 1; k < lines.length; k += 1) {
    const t = lines[k].text;
    if (t.trim() === "" || /^\s*#/.test(t)) continue;
    if (/^[ \t]/.test(t)) return text; // still has children
    break;
  }
  const orig = originalText == null
    ? null
    : splitLines(originalText).find((l) => new RegExp(`^${key}:`).test(l.text));
  if (originalText == null) return text; // pre-install state unknown — leave it
  if (orig) {
    if (isHeader(orig.text)) return text;
    lines[h] = { ...lines[h], text: orig.text };
    return joinLines(lines);
  }
  let start = h;
  if (start > 0 && lines[start - 1].text.trim() === "") start -= 1;
  lines.splice(start, h - start + 1);
  return joinLines(lines);
}

/**
 * Line range [start, end) of top-level YAML `key:` plus its indented children
 * (blank/comment lines inside the block included), or null.
 */
function yamlTopLevelBlock(lines, key) {
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`);
  const start = lines.findIndex((l) => re.test(l.text));
  if (start < 0) return null;
  let end = start + 1;
  let lastChild = start;
  while (end < lines.length) {
    const t = lines[end].text;
    if (/^[ \t]+\S/.test(t)) lastChild = end;
    else if (t.trim() !== "" && !/^\s*#/.test(t)) break;
    end += 1;
  }
  return { start, end: lastChild + 1 };
}

/** Text of a top-level YAML block (key line + children), or null. */
function yamlTopLevelText(text, key) {
  const lines = splitLines(text);
  const b = yamlTopLevelBlock(lines, key);
  return b ? joinLines(lines.slice(b.start, b.end)) : null;
}

/** Remove a top-level YAML block and one blank separator line before it. */
function removeYamlTopLevelKey(text, key) {
  const lines = splitLines(text);
  const b = yamlTopLevelBlock(lines, key);
  if (!b) return text;
  let start = b.start;
  if (start > 0 && lines[start - 1].text.trim() === "") start -= 1;
  lines.splice(start, b.end - start);
  return joinLines(lines);
}

// ── Pre-install snapshots ────────────────────────────────────────────────────

/**
 * Prune `data.<keys…>` from the deepest level up while each level is an empty
 * object/array that `original` (the pre-install config) did not have. With
 * `original` unknown (null) nothing is pruned.
 */
function pruneCreatedEmpty(data, original, keys) {
  if (!isPlainObject(original)) return;
  for (let depth = keys.length; depth >= 1; depth -= 1) {
    const parentKeys = keys.slice(0, depth - 1);
    const key = keys[depth - 1];
    let parent = data;
    let origParent = original;
    for (const k of parentKeys) {
      parent = isPlainObject(parent) ? parent[k] : undefined;
      origParent = isPlainObject(origParent) ? origParent[k] : undefined;
    }
    if (!isPlainObject(parent)) return;
    const v = parent[key];
    const empty = Array.isArray(v) ? v.length === 0 : isPlainObject(v) && Object.keys(v).length === 0;
    if (!empty) return;
    if (isPlainObject(origParent) && Object.prototype.hasOwnProperty.call(origParent, key)) return;
    delete parent[key];
  }
}

// ── Plain text ───────────────────────────────────────────────────────────────

/** Whitespace-insensitive comparison key for text configs. */
function normalizeText(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Every line and block comment in a JSONC text (outside strings). */
function jsonComments(text) {
  const out = [];
  const t = String(text);
  let i = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === '"') {
      i += 1;
      while (i < t.length && t[i] !== '"') i += t[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === "/" && t[i + 1] === "/") {
      const e = t.indexOf("\n", i);
      const end = e < 0 ? t.length : e;
      out.push(t.slice(i, end).trim());
      i = end;
      continue;
    }
    if (c === "/" && t[i + 1] === "*") {
      const e = t.indexOf("*/", i + 2);
      const end = e < 0 ? t.length : e + 2;
      out.push(t.slice(i, end).trim());
      i = end;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * Read a JSON/JSONC file, let `mutate(data)` edit a copy, and write back only
 * the changed spans. Missing, empty, malformed or non-object files are left
 * untouched (never wiped). Returns true when the file was rewritten.
 */
function editJsonFile(filePath, mutate) {
  const fs = require("fs");
  if (!fs.existsSync(filePath)) return false;
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) return false;
  let data;
  try {
    data = parseJsonLoose(raw);
  } catch (err) {
    console.error(`  ⚠ ${filePath} is not valid JSON (${err.message}); left untouched.`);
    return false;
  }
  if (!isPlainObject(data)) return false;
  const next = JSON.parse(JSON.stringify(data));
  mutate(next);
  if (deepEqual(next, data)) return false;
  fs.writeFileSync(filePath, rewriteJson(raw, next));
  return true;
}

module.exports = {
  scanJsonc,
  parseJsonLoose,
  applyJsonDiff,
  rewriteJson,
  deepEqual,
  isPlainObject,
  parseTomlLines,
  removeTomlTable,
  hasTomlTable,
  findTomlKey,
  replaceTomlLine,
  hasExactTomlTable,
  dropEmptyTomlTable,
  dropEmptyYamlKey,
  yamlTopLevelText,
  pruneCreatedEmpty,
  removeYamlTopLevelKey,
  normalizeText,
  jsonComments,
  editJsonFile,
};
