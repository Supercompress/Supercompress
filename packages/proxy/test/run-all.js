#!/usr/bin/env node
/**
 * Run every SuperCompress proxy test suite for launch sign-off.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const suites = [
  ["smoke", "test/smoke.js"],
  ["protocol-safety", "test/protocol-safety.js"],
  ["sse-stream", "test/sse-stream.js"],
  ["agent-plugins", "test/agent-plugins.js"],
  ["uninstall-clean", "test/uninstall-clean.js"],
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
  const res = spawnSync(process.execPath, [path.join(ROOT, rel)], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300000,
    env: { ...process.env },
  });
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
