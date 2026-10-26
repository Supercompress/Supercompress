const test = require("node:test");
const assert = require("node:assert/strict");
const { sumShards, nextClaims, emptyStats } = require("./_lib/limitcheck-stats");
const { parseEvent } = require("./limitcheck");

test("parseEvent keeps known verdicts and surfaces, defaults the rest", () => {
  assert.deepEqual(parseEvent({ action: "LAND", surface: "mcp" }), { action: "land", surface: "mcp" });
  assert.deepEqual(parseEvent({ action: "drop table", surface: "x" }), { action: "unknown", surface: "cli" });
  assert.deepEqual(parseEvent(null), { action: "unknown", surface: "cli" });
});

test("nextClaims increments one shard without touching other claims", () => {
  const first = nextClaims({ other: 1 }, { action: "go", surface: "cli" }, "2026-10-25T00:00:00.000Z");
  const second = nextClaims(first, { action: "wait", surface: "mcp" }, "2026-10-25T00:00:01.000Z");
  assert.equal(second.other, 1);
  assert.deepEqual(second.lc, { n: 2, go: 1, wait: 1, cli: 1, mcp: 1, at: "2026-10-25T00:00:01.000Z" });
});

test("sumShards adds every shard and ignores junk", () => {
  const total = sumShards([
    { lc: { n: 3, go: 2, land: 1, cli: 3, at: "2026-10-25T00:00:00.000Z" } },
    { lc: { n: 2, wait: 1, unknown: 1, mcp: 2, at: "2026-10-25T01:00:00.000Z" } },
    { lc: { n: "x", go: -4 } },
    {},
  ]);
  assert.equal(total.invocations, 5);
  assert.deepEqual(total.actions, { go: 2, land: 1, pace: 0, wait: 1, unknown: 1 });
  assert.deepEqual(total.surfaces, { cli: 3, mcp: 2 });
  assert.equal(total.updated_at, "2026-10-25T01:00:00.000Z");
  assert.equal(emptyStats().invocations, 0);
});
