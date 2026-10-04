#!/usr/bin/env node
/**
 * Fail CI when committed benchmark artifacts mark quality gates as failing,
 * except suites explicitly tracked as known-red (must cite an issue).
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "web/assets/data");

/** Known-red suites still published for honesty — do not expand without an issue. */
const KNOWN_RED = {
  "fresh6-benchmark-latest.json": "#199 — answer containment below always_answer_ge_98",
  "validate-benchmark-latest.json": "legacy validate artifact with gates.pass=false — do not cite as shipping quality",
};

const files = fs.existsSync(dataDir)
  ? fs.readdirSync(dataDir).filter((f) => f.endsWith("-benchmark-latest.json"))
  : [];

if (!files.length) {
  console.log("No *-benchmark-latest.json artifacts — skip.");
  process.exit(0);
}

let failed = false;
for (const file of files) {
  const full = path.join(dataDir, file);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (err) {
    console.error(`❌ Unparseable ${file}: ${err.message}`);
    failed = true;
    continue;
  }
  const gates = data.gates || data.overall?.gates || null;
  const pass = gates && typeof gates.pass === "boolean" ? gates.pass : null;
  const answerRate =
    data.overall?.answer_all_kept_rate ??
    data.summary?.answer_all_kept_rate ??
    null;
  console.log(
    `📦 ${file}: gates.pass=${pass} answer_all_kept_rate=${answerRate}`
  );
  if (pass === false) {
    if (KNOWN_RED[file]) {
      console.warn(`⚠️  ${file} is known-red (${KNOWN_RED[file]}) — not blocking CI.`);
      continue;
    }
    console.error(
      `❌ ${file} has gates.pass=false — do not ship while answer-containment gates fail.`
    );
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("✅ Benchmark quality gate check complete.");
