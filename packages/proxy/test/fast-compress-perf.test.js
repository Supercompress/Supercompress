"use strict";

// Hosted /v1/compress accepts up to 120k characters of untrusted text. Each case here once took
// seconds to minutes (regex backtracking or a quadratic scan); all must stay well under a second.
const test = require("node:test");
const assert = require("node:assert/strict");
const { compress } = require("../src/fast-compress.js");

const N = 120_000;
const repeat = (unit) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
const lines = (line) => (line + "\n").repeat(Math.ceil(N / (line.length + 1))).slice(0, N);
const QUERY = "Where is the AuthTimeout error in a.js line 12? Ignore: def foo";
const LIMIT_MS = 2000;

const cases = {
  "search-hit path with repeated ./ segments": repeat(".a/") + "!",
  "one long dotted token": repeat("a.") + "!",
  "one long snake token": repeat("_a"),
  "one long colon token": repeat("a:1"),
  "one long dashed token": repeat("-a"),
  "url with a long dotted host": "http://" + repeat("a."),
  "blank lines": "x\n" + "\n".repeat(N - 3) + "x",
  "single-space lines": "x\n" + repeat(" \n") + "x",
  "fence-only lines": lines("```"),
  "one long space line": "x\n" + repeat(" ") + "\nx",
  "one long indented call-like line": repeat(" a("),
  "long camel-case id": "Ab" + repeat("A"),
};

for (const [name, context] of Object.entries(cases)) {
  test(`stays fast on ${name}`, () => {
    const started = Date.now();
    const result = compress(context, QUERY);
    const elapsed = Date.now() - started;
    assert.equal(typeof result.compressed_text, "string");
    assert.ok(elapsed < LIMIT_MS, `${name}: ${elapsed}ms`);
  });
}
