#!/usr/bin/env node
/**
 * Fast local test runner for SuperCompress unit tests and repository guards.
 * Run via: npm test  or  node scripts/test-unit.js
 *
 * Auto-discovers *.test.js files across api/, scripts/, and web/assets/js/
 * to ensure newly added test suites are never silently skipped.
 */
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

/**
 * Directories scanned for unit test files (*.test.js).
 */
const TEST_SEARCH_DIRS = ["api", "scripts", "web/assets/js"];

/**
 * Repository integrity guards executed after unit tests.
 */
const REPO_GUARDS = [
  { name: "guard: check-no-pii", file: "scripts/check-no-pii.js" },
  { name: "guard: check-versions", file: "scripts/check-versions.js" },
  { name: "guard: check-stylesheet-paths", file: "scripts/check-stylesheet-paths.js" },
  { name: "guard: check-api-host-routes", file: "scripts/check-api-host-routes.js" },
  { name: "guard: sync-compress-assets", file: "scripts/sync-compress-assets.js", args: ["--check"] },
];

/**
 * Recursively scans directories to discover all unit test files.
 *
 * @param {string[]} searchDirs - Array of directory paths relative to repoRoot.
 * @param {string} [repoRoot=ROOT] - Root directory of the repository.
 * @returns {Array<{ name: string, file: string, args?: string[] }>} List of discovered test suite definitions.
 */
function findTestFiles(searchDirs = TEST_SEARCH_DIRS, repoRoot = ROOT) {
  const discovered = [];

  /**
   * Helper to walk directories recursively.
   *
   * @param {string} currentDir - Current directory path.
   * @returns {void}
   */
  function walk(currentDir) {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".git") {
          walk(fullPath);
        }
      } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
        const relFile = path.relative(repoRoot, fullPath).replace(/\\/g, "/");
        const name = relFile.replace(/\.test\.js$/, "");
        const content = fs.readFileSync(fullPath, "utf8");
        const usesNodeTestRunner = /require\(["']node:test["']\)|from\s+["']node:test["']/.test(content);

        discovered.push({
          name: `unit: ${name}`,
          file: relFile,
          ...(usesNodeTestRunner ? { args: ["--test"] } : {}),
        });
      }
    }
  }

  for (const dir of searchDirs) {
    walk(path.join(repoRoot, dir));
  }

  return discovered.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Builds the complete list of test suites, combining auto-discovered unit tests and repository guards.
 *
 * @param {string} [repoRoot=ROOT] - Root directory of the repository.
 * @returns {Array<{ name: string, file: string, args?: string[] }>} Combined list of test suites.
 */
function buildTestSuiteList(repoRoot = ROOT) {
  const unitTests = findTestFiles(TEST_SEARCH_DIRS, repoRoot);
  return [...unitTests, ...REPO_GUARDS];
}

/**
 * Executes a single test suite process synchronously.
 *
 * @param {{ name: string, file: string, args?: string[] }} suite - Suite configuration.
 * @param {string} [repoRoot=ROOT] - Root directory of the repository.
 * @returns {{ ok: boolean, status: number | null, stdout: string, stderr: string }} Execution result.
 */
function runSuite(suite, repoRoot = ROOT) {
  const fullPath = path.join(repoRoot, suite.file);
  const args = [...(suite.args || []), fullPath];

  const res = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env },
  });

  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

/**
 * Executes all test suites and repository guards, printing formatted results.
 *
 * @param {Array<{ name: string, file: string, args?: string[] }>} [suites] - Optional list of suites to run.
 * @param {string} [repoRoot=ROOT] - Root directory of the repository.
 * @returns {boolean} True if all suites passed, false otherwise.
 */
function runAllSuites(suites = buildTestSuiteList(ROOT), repoRoot = ROOT) {
  console.log(`\n Running SuperCompress Unit Tests & Repository Guards (${suites.length} suites)...\n`);

  let passed = 0;
  let failed = 0;
  const failedSuites = [];

  for (const suite of suites) {
    const res = runSuite(suite, repoRoot);

    if (res.ok) {
      passed++;
      console.log(`   PASS  ${suite.name}`);
    } else {
      failed++;
      failedSuites.push(suite.name);
      console.error(`   FAIL  ${suite.name} (exit ${res.status})`);
      if (res.stdout.trim()) console.log(res.stdout.trim());
      if (res.stderr.trim()) console.error(res.stderr.trim());
    }
  }

  console.log("\n" + "─".repeat(60));
  console.log(`Total: ${suites.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log("─".repeat(60));

  if (failed > 0) {
    console.error(`\n \u274C Failed suites: ${failedSuites.join(", ")}`);
    return false;
  }

  console.log("\n \u2705 All unit tests and repository guards passed!\n");
  return true;
}

/**
 * CLI entry point for the test runner.
 *
 * @returns {void}
 */
function main() {
  const success = runAllSuites();
  process.exit(success ? 0 : 1);
}

module.exports = {
  TEST_SEARCH_DIRS,
  REPO_GUARDS,
  findTestFiles,
  buildTestSuiteList,
  runSuite,
  runAllSuites,
  main,
};

if (require.main === module) {
  main();
}
