#!/usr/bin/env node
/**
 * Unit tests for compress asset synchronization guard logic.
 * Run via: node scripts/sync-compress-assets.test.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  ASSET_PAIRS,
  checkSynced,
  syncAssets,
} = require("./sync-compress-assets");

/**
 * Runs unit tests validating checkSynced and syncAssets behavior.
 *
 * @returns {void}
 */
function runTests() {
  // Test 1: Real repository assets must be in sync
  const liveResult = checkSynced();
  assert.strictEqual(
    liveResult.ok,
    true,
    `Live repo assets are out of sync:\n${liveResult.errors.join("\n")}`
  );

  // Test 2: Missing source file detection
  const missingSourceResult = checkSynced(process.cwd(), [
    ["nonexistent/source.js", "packages/proxy/src/assets/compress-engine.js"],
  ]);
  assert.strictEqual(missingSourceResult.ok, false);
  assert.ok(
    missingSourceResult.errors.some((e) => e.includes("Missing canonical source asset")),
    "Should detect missing source file"
  );

  // Test 3: Missing destination file detection
  const missingDestResult = checkSynced(process.cwd(), [
    ["web/assets/js/compress-engine.js", "nonexistent/dest.js"],
  ]);
  assert.strictEqual(missingDestResult.ok, false);
  assert.ok(
    missingDestResult.errors.some((e) => e.includes("Missing synced asset copy")),
    "Should detect missing destination copy"
  );

  // Test 4: Mismatch detection in temporary workspace
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-sync-test-"));
  try {
    const srcDir = path.join(tempDir, "src");
    const dstDir = path.join(tempDir, "dst");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(dstDir, { recursive: true });

    const srcFile = path.join(srcDir, "engine.js");
    const dstFile = path.join(dstDir, "engine.js");

    fs.writeFileSync(srcFile, "console.log('version 1');", "utf8");
    fs.writeFileSync(dstFile, "console.log('version 2');", "utf8");

    const pair = [["src/engine.js", "dst/engine.js"]];
    const mismatchResult = checkSynced(tempDir, pair);
    assert.strictEqual(mismatchResult.ok, false);
    assert.ok(
      mismatchResult.errors.some((e) => e.includes("out of sync")),
      "Should detect mismatched file contents"
    );

    // Test 5: syncAssets resolves mismatch
    syncAssets(tempDir, pair);
    const postSyncResult = checkSynced(tempDir, pair);
    assert.strictEqual(postSyncResult.ok, true, "Asset sync should make files identical");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  // Test 6: Verify required pairs are registered
  assert.ok(ASSET_PAIRS.length >= 4, "Must cover at least 4 canonical asset copies");

  console.log("sync-compress-assets.test.js: ok");
}

if (require.main === module) {
  runTests();
}

module.exports = { runTests };
