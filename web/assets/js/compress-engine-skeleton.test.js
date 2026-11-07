/**
 * Unit tests for the code skeleton guard in compressAdaptive.
 * Run: node web/assets/js/compress-engine-skeleton.test.js
 *
 * On source code the compiler can drop `def`/`class` lines and keep orphan bodies, so an agent
 * cannot follow a call to its callee (real Cursor-agent study, 2026-11-06: code-multihop 0.30
 * compressed vs 1.00 uncompressed). The guard keeps every signature line plus the full body of any
 * function the question names, in original order.
 */
const assert = require("assert");

require("./compress-engine.js");
const E = globalThis.SuperCompressEngine;
const model = require("../data/model.json");

function pyModule() {
  const out = ['"""Inventory helpers."""', "import os", "import re", ""];
  for (let i = 0; i < 30; i++) {
    out.push(`def helper_${i}(record_${i}, limit=${i}):`);
    out.push(`    """Normalize record ${i} for the warehouse ledger and audit trail."""`);
    for (let j = 0; j < 6; j++) out.push(`    value_${j} = str(record_${i}).strip().lower() + "${"x".repeat(20 + j)}"`);
    out.push(`    return value_0[:limit]`);
    out.push("");
  }
  out.push("def reconcile_stock(entries, strict=False):");
  out.push('    """Reconcile stock entries against the ledger."""');
  out.push("    cleaned = [helper_17(e) for e in entries]");
  out.push("    return sorted(cleaned)");
  out.push("");
  return out.join("\n");
}

const text = pyModule();
const question =
  "The top-level function `reconcile_stock` in this Python module calls exactly one other top-level function defined in the same module. What is the name of the first parameter of that function?";
const r = E.compressAdaptive(text, question, model);
const out = r.compressed_text;

assert.ok(out.length < text.length * 0.8, "code is still compressed substantially");
assert.ok(out.includes("def helper_17(record_17, limit=17):"), "callee signature kept");
assert.ok(out.includes("    cleaned = [helper_17(e) for e in entries]"), "named function body kept");
assert.ok(out.includes("def reconcile_stock(entries, strict=False):"), "named function signature kept");
for (let i = 0; i < 30; i++) assert.ok(out.includes(`def helper_${i}(`), `signature helper_${i} kept`);
// Lines stay in original order.
assert.ok(out.indexOf("def helper_17(") < out.indexOf("def reconcile_stock("), "original order");
assert.strictEqual(r.code_skeleton, true);
assert.ok(r.kept_tokens > 0 && r.tokens_saved_pct > 0 && r.tokens_saved_pct < 100, "token stats recomputed");

// TypeScript dump with Read-tool line-number prefixes ("  12→").
function tsModule() {
  const out = ['import { readFile } from "node:fs/promises";', 'import path from "node:path";', ""];
  for (let i = 0; i < 25; i++) {
    out.push(`export async function loadShard${i}(shardPath: string, retries = ${i}): Promise<string> {`);
    for (let j = 0; j < 6; j++) out.push(`  const part${j} = await readFile(path.join(shardPath, "chunk-${j}-${"y".repeat(18 + j)}"), "utf8");`);
    out.push("  return part0 + part1;");
    out.push("}");
    out.push("");
  }
  out.push("export const mergeShards = async (manifest: string[], strict = false) => {");
  out.push("  const parts = await Promise.all(manifest.map((m) => loadShard12(m)));");
  out.push('  return parts.join("\\n");');
  out.push("};");
  return out.map((l, i) => `${String(i + 1).padStart(6)}→${l}`).join("\n");
}
const ts = tsModule();
const tq = "On which line number is the function `mergeShards` defined, and what is the first parameter of `loadShard12`?";
const tr = E.compressAdaptive(ts, tq, model);
assert.ok(tr.compressed_text.length < ts.length * 0.8, "TS is still compressed substantially");
assert.ok(/→export async function loadShard12\(shardPath: string, retries = 12\)/.test(tr.compressed_text), "TS callee signature kept with its line number");
assert.ok(/→export const mergeShards = async \(manifest/.test(tr.compressed_text), "arrow-function definition kept");
assert.ok(tr.compressed_text.includes("loadShard12(m)"), "named arrow-function body kept");
assert.strictEqual(tr.code_skeleton, true);

// Prose is not touched by the guard.
const prose = Array.from({ length: 80 }, (_, i) => `Paragraph ${i}: the river delta flooded in spring and the harvest moved north that year.`).join("\n");
const p = E.compressAdaptive(prose, "Which direction did the harvest move?", model);
assert.strictEqual(p.code_skeleton, undefined, "guard does not run on prose");

console.log("compress-engine-skeleton.test.js: ok");
