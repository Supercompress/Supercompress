#!/usr/bin/env node
/**
 * Sync canonical compress assets from web/ into package + API copies.
 * Source of truth: web/assets/js/compress-engine.js + web/assets/data/model.json
 *
 * Usage:
 *   node scripts/sync-compress-assets.js          # Sync copies from canonical sources
 *   node scripts/sync-compress-assets.js --check  # Validate that copies match canonical sources
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const ASSET_PAIRS = [
  ["web/assets/js/compress-engine.js", "packages/proxy/src/assets/compress-engine.js"],
  ["web/assets/data/model.json", "packages/proxy/src/assets/model.json"],
  ["web/assets/js/compress-engine.js", "api/_lib/compress-engine.js"],
  ["web/assets/data/model.json", "api/_lib/model.json"],
];

/**
 * Validates that all destination asset copies match canonical source assets.
 *
 * @param {string} [repoRoot=ROOT] - Root directory of the repository.
 * @param {Array<[string, string]>} [pairs=ASSET_PAIRS] - Array of [source, destination] relative path pairs.
 * @returns {{ ok: boolean, errors: string[] }} Result object containing pass status and error list.
 */
function checkSynced(repoRoot = ROOT, pairs = ASSET_PAIRS) {
  const errors = [];

  for (const [fromRel, toRel] of pairs) {
    const from = path.join(repoRoot, fromRel);
    const to = path.join(repoRoot, toRel);

    if (!fs.existsSync(from)) {
      errors.push(`Missing canonical source asset: ${fromRel}`);
      continue;
    }

    if (!fs.existsSync(to)) {
      errors.push(`Missing synced asset copy: ${toRel} (expected sync from ${fromRel}). Run 'npm run sync:assets'`);
      continue;
    }

    const fromBuf = fs.readFileSync(from);
    const toBuf = fs.readFileSync(to);

    if (!fromBuf.equals(toBuf)) {
      errors.push(`Asset out of sync: ${toRel} does not match canonical ${fromRel}. Run 'npm run sync:assets'`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Copies canonical source assets to their respective target destinations.
 *
 * @param {string} [repoRoot=ROOT] - Root directory of the repository.
 * @param {Array<[string, string]>} [pairs=ASSET_PAIRS] - Array of [source, destination] relative path pairs.
 * @returns {{ ok: boolean, synced: Array<[string, string]> }} Summary of synced pairs.
 */
function syncAssets(repoRoot = ROOT, pairs = ASSET_PAIRS) {
  for (const [fromRel, toRel] of pairs) {
    const from = path.join(repoRoot, fromRel);
    const to = path.join(repoRoot, toRel);

    if (!fs.existsSync(from)) {
      throw new Error(`Missing source asset: ${fromRel}`);
    }

    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    console.log(`synced ${fromRel} \u2192 ${toRel}`);
  }

  return { ok: true, synced: pairs };
}

/**
 * Main entry point: performs asset synchronization or check based on CLI arguments.
 *
 * @param {string[]} [args=process.argv.slice(2)] - Command-line arguments.
 * @returns {void}
 */
function main(args = process.argv.slice(2)) {
  const isCheckMode = args.includes("--check");

  if (isCheckMode) {
    const result = checkSynced();
    if (!result.ok) {
      console.error("\u274C Compress asset synchronization guard failed:\n" + result.errors.map((e) => `  - ${e}`).join("\n"));
      process.exit(1);
    }
    console.log(`\u2705 Compress assets stay in sync: all ${ASSET_PAIRS.length} target files match canonical sources`);
    process.exit(0);
  } else {
    syncAssets();
    console.log("\u2705 All canonical compress assets successfully synced");
  }
}

module.exports = {
  ASSET_PAIRS,
  checkSynced,
  syncAssets,
  main,
};

if (require.main === module) {
  main();
}
