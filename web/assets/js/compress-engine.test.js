/**
 * Unit tests for the log preprocessor's dedup step.
 * Run: node web/assets/js/compress-engine.test.js
 *
 * Regression cover for the case where lines differing only in their digits
 * were folded into one another, silently dropping distinct ids.
 */
const assert = require("assert");

require("./compress-engine.js");
const E = globalThis.SuperCompressEngine;
const model = require("../data/model.json");

const compress = (ctx, q) =>
  E.compressAdaptive(ctx, q, model, { includeAnnotations: false }).compressed_text;

// ── Distinct ids on severe lines must all survive ──────────────────────────
// Every line here differs only in the order id, so a digit-blind fingerprint
// treats all twenty as repeats of the first and keeps three.
const ids = Array.from({ length: 20 }, (_, i) => `ORD-${10000 + i * 137}`);
const declined = compress(
  ids.map((id) => `2026-03-01T09:00:00Z ERROR payment declined for order ${id} code=51`).join("\n"),
  "which orders were declined?"
);
for (const id of ids) {
  assert.ok(declined.includes(id), `ERROR line for ${id} must survive dedup`);
}

// The same holds for the other severities that carry evidence.
for (const level of ["WARN", "FATAL", "CRITICAL"]) {
  const out = compress(
    [1, 2, 3, 4, 5]
      .map((n) => `2026-03-01T09:00:0${n}Z ${level} disk usage at ${80 + n}% on /dev/sda${n}`)
      .join("\n"),
    "which disk is nearly full?"
  );
  for (const n of [1, 2, 3, 4, 5]) {
    assert.ok(out.includes(`/dev/sda${n}`), `${level}: /dev/sda${n} must survive dedup`);
  }
}

// ── Low-severity noise must still collapse ────────────────────────────────
// This is what the dedup exists for, and the fix must not cost it.
const noise = Array.from(
  { length: 200 },
  (_, i) => `2026-03-01T09:00:00Z INFO processed request ${i} in ${10 + (i % 5)}ms`
).join("\n");
const collapsed = compress(noise, "any errors?");
assert.ok(
  collapsed.split("\n").length <= 5,
  `INFO noise must still collapse, got ${collapsed.split("\n").length} lines`
);

// ── The marker reports the real number of suppressed lines ────────────────
// 200 occurrences, three kept, so 197 are suppressed.
const marker = collapsed.match(/\[\+(\d+) more suppressed\]/);
assert.ok(marker, "a collapsed group must carry a marker");
assert.strictEqual(Number(marker[1]), 197, "marker must count the lines actually suppressed");

// Exactly three occurrences suppress nothing, so no marker is emitted.
const exactlyThree = compress(
  Array.from({ length: 3 }, () => "2026-03-01T09:00:00Z INFO cache warmed").join("\n"),
  "was the cache warmed?"
);
assert.ok(
  !/more suppressed/.test(exactlyThree),
  "three occurrences suppress nothing and must not be marked"
);

// ── Ids that mix letters into digits were never affected; keep it that way ──
const traceIds = ["7f3a91", "8b2c04", "9d5e17"];
const traces = compress(
  traceIds
    .map((id, i) => `2026-04-0${i + 1}T11:0${i}:00Z ERROR upstream call failed trace_id=${id}`)
    .join("\n"),
  "which trace ids failed?"
);
for (const id of traceIds) {
  assert.ok(traces.includes(id), `trace_id=${id} must survive`);
}

console.log("compress-engine.test.js: ok");
