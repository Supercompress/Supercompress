"use strict";

// Agent tool output rules in fast-compress.js: size floor, search-hit listings, tool status
// lines, test verdicts and navigation targets. Inputs are written here, not taken from
// compress-bench, so these tests do not encode benchmark tasks.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { compress, internals } = require("../src/fast-compress");

const filler = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

test("inputs under the size floor pass through unchanged", () => {
  const input = filler(30, (i) => `INFO job=${i} ok`).join("\n");
  assert.ok(input.length < internals.MIN_COMPRESS_CHARS);
  const out = compress(input, "which job failed?");
  assert.equal(out.compressed_text, input);
  assert.equal(out.selection_reason, "below_min_size");
});

test("minChars: 0 turns the floor off", () => {
  const rows = filler(60, (i) => `INFO job=${i} ok`);
  rows[31] = "ERROR job=31 disk full on /var/data";
  const input = rows.join("\n");
  const out = compress(input, "which job failed with an error?", { minChars: 0 });
  assert.notEqual(out.selection_reason, "below_min_size");
  assert.ok(out.compressed_text.includes("disk full"));
  assert.ok(out.compressed_text.length < input.length);
});

test("search-hit listings keep every hit", () => {
  for (const format of [(i) => `Line ${i * 7}:    total = compute_total(items_${i})`, (i) => `src/billing/mod_${i}.py:${i * 3}:    total = compute_total(x)`, (i) => `src/billing/mod_${i}.py:    total = compute_total(x)`]) {
    const input = ['Found 120 matches for "compute_total":', ...filler(120, format), 'End of matches for "compute_total"'].join("\n");
    assert.ok(input.length > internals.MIN_COMPRESS_CHARS);
    const out = compress(input, "find where compute_total is called");
    assert.equal(out.selection_reason, "hit_list_kept");
    assert.equal(out.compressed_text, input);
  }
});

test("pytest node ids and log lines are not mistaken for search hits", () => {
  assert.equal(internals.isHitListing(filler(50, (i) => `tests/test_api.py::test_case_${i} PASSED`)), false);
  assert.equal(internals.isHitListing(filler(50, (i) => `2026-11-24T10:00:${String(i).padStart(2, "0")}.120Z worker ok`)), false);
});

test("trailing tool status lines survive compression", () => {
  const lines = ["[File: /repo/app/models.py (900 lines total)]", "(200 more lines above)"];
  for (let i = 0; i < 120; i++) lines.push(`${201 + i}:        self.field_${i} = kwargs.get("field_${i}")`);
  lines.push("(579 more lines below)", "File updated. Please review the changes and make sure they are correct.");
  const input = lines.join("\n");
  const out = compress(input, "check how field_57 is initialised");
  assert.ok(out.compressed_text.length < input.length);
  assert.ok(out.compressed_text.includes("field_57"));
  assert.ok(out.compressed_text.includes("[File: /repo/app/models.py"));
  assert.ok(out.compressed_text.includes("File updated."));
});

test("ordinary trailing rows are not kept as status lines", () => {
  const rows = filler(80, (i) => `INSERT INTO events VALUES (${i}, 'tick', ${i * 10});`);
  rows[40] = "INSERT INTO events VALUES (40, 'refund_issued', 9001);";
  const input = rows.join("\n");
  const out = compress(input, "which event was a refund?", { minChars: 0 });
  assert.ok(out.compressed_text.includes("refund_issued"));
  assert.ok(!out.compressed_text.includes("(79, 'tick'"));
});

test("test runs keep failure and summary lines", () => {
  const lines = ["============================= test session starts ==============================", "platform linux -- Python 3.11.4, pytest-8.3.2"];
  for (let i = 0; i < 150; i++) lines.push(`tests/test_orders.py::test_order_${i} PASSED [${Math.round((i / 150) * 100)}%]`);
  lines.push("tests/test_orders.py::test_refund_rounding FAILED [100%]");
  lines.push("=================================== FAILURES ===================================");
  lines.push("E       assert 10.01 == 10.0");
  lines.push("========================= 1 failed, 150 passed in 3.21s =========================");
  const input = lines.join("\n");
  const out = compress(input, "run the tests after the rounding change");
  assert.ok(out.compressed_text.length < input.length / 2);
  for (const needle of ["test_refund_rounding FAILED", "assert 10.01 == 10.0", "1 failed, 150 passed"]) {
    assert.ok(out.compressed_text.includes(needle), needle);
  }
});

test("a goto target keeps the code around that line", () => {
  assert.deepEqual(internals.targetLineNumbers("let's look at it.\n$ goto 563"), [563]);
  assert.deepEqual(internals.targetLineNumbers("$ edit 165:170"), [165, 170]);
  assert.equal(internals.viewLineNumber("586:        fov = self.fieldOfView()"), 586);
  const lines = ["[File: /repo/optics/path.py (1115 lines total)]"];
  for (let n = 500; n < 650; n++) lines.push(`${n}:        value_${n} = step(value_${n - 1})`);
  const input = lines.join("\n");
  const out = compress(input, "The imageSize method is at line 563, let's read it.\n$ goto 563");
  for (const n of [555, 563, 590, 600]) assert.ok(out.compressed_text.includes(`${n}:        value_${n}`), String(n));
  assert.ok(out.compressed_text.length < input.length);
});
