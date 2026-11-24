#!/usr/bin/env node
/**
 * Run every SuperCompress proxy test suite for launch sign-off.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Suites run `supercompress plugin` and similar commands that write agent configs
// under $HOME. Give each suite a throwaway home so a contributor's real Cursor/Claude/
// Codex configs are never touched. SC_TEST_LIVE_HOME=1 keeps the real home for
// launch sign-off on a machine with a live install.
const LIVE_HOME = process.env.SC_TEST_LIVE_HOME === "1";

function suiteEnv() {
  // Test runs must never count on the public limitcheck total.
  const env = { ...process.env, SUPERCOMPRESS_TELEMETRY: "0" };
  if (LIVE_HOME) return { env, cleanup() {} };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sc-proxy-home-"));
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
  });
  delete env.SUPERCOMPRESS_CONFIG_DIR;
  return { env, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

const ROOT = path.join(__dirname, "..");
const suites = [
  ["tui-quota", "test/tui-quota.js"],
  ["smoke", "test/smoke.js"],
  ["protocol-safety", "test/protocol-safety.js"],
  ["mcp-safety", "test/mcp-safety.test.js"],
  ["sse-stream", "test/sse-stream.js"],
  ["agent-plugins", "test/agent-plugins.js"],
  ["hook-packaging", "test/hook-packaging.js"],
  ["limits", "test/limits.js"],
  ["runway-sim", "test/runway-sim.js"],
  ["harness-writers", "test/harness-writers.js"],
  ["grok-build", "test/grok-build.js"],
  ["grok-bot", "test/grok-bot.js"],
  ["fx-build", "test/fx-build.js"],
  ["uninstall-clean", "test/uninstall-clean.js"],
  ["uninstall-preserves-user-config", "test/uninstall-preserves-user-config.js"],
  ["dual-launch", "test/dual-launch.js"],
  ["compress-deep", "test/compress-deep.js"],
  ["bug-hunt", "test/bug-hunt.js"],
  ["launch-ready", "test/launch-ready.js"],
  ["review", "test/review.js"],
];

let failed = 0;
console.log("\n████  SuperCompress FULL LAUNCH TEST MATRIX  ████\n");

for (const [name, rel] of suites) {
  console.log(`\n──────── suite: ${name} ────────`);
  const { env, cleanup } = suiteEnv();
  const res = spawnSync(process.execPath, [path.join(ROOT, rel)], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300000,
    env,
  });
  cleanup();
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) {
    failed += 1;
    console.error(`\n✘ suite ${name} failed (exit ${res.status}${res.signal ? ` signal=${res.signal}` : ""})`);
  } else {
    console.log(`\n✔ suite ${name} passed`);
  }
}

console.log("\n████  MATRIX DONE  ████");
console.log(failed ? `FAILED suites: ${failed}/${suites.length}` : `ALL ${suites.length} suites passed — safe to launch.`);
process.exitCode = failed ? 1 : 0;
