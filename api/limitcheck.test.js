const test = require("node:test");
const assert = require("node:assert/strict");
const { sumShards, nextClaims, emptyStats, writeLanded, RECENT } = require("./_lib/limitcheck-stats");
const { parseEvent } = require("./limitcheck");

test("parseEvent keeps known verdicts and surfaces, defaults the rest", () => {
  assert.deepEqual(parseEvent({ action: "LAND", surface: "mcp" }), { action: "land", surface: "mcp" });
  assert.deepEqual(parseEvent({ action: "drop table", surface: "x" }), { action: "unknown", surface: "cli" });
  assert.deepEqual(parseEvent(null), { action: "unknown", surface: "cli" });
});

test("nextClaims increments one shard without touching other claims", () => {
  const first = nextClaims({ other: 1 }, { action: "go", surface: "cli" }, "2026-10-25T00:00:00.000Z", "aaa");
  const second = nextClaims(first, { action: "wait", surface: "mcp" }, "2026-10-25T00:00:01.000Z", "bbb");
  assert.equal(second.other, 1);
  assert.deepEqual(second.lc, { n: 2, go: 1, wait: 1, cli: 1, mcp: 1, at: "2026-10-25T00:00:01.000Z", r: ["bbb", "aaa"] });
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

test("writeLanded spots a concurrent overwrite", () => {
  const base = { lc: { n: 5, r: ["x"] } };
  const mine = nextClaims(base, { action: "go", surface: "cli" }, "t", "mine");
  const theirs = nextClaims(base, { action: "go", surface: "cli" }, "t", "theirs");
  // Both read n=5; theirs landed last, so mine is lost.
  assert.equal(writeLanded(theirs, { nonce: "mine", n: 6 }), false);
  assert.equal(writeLanded(mine, { nonce: "mine", n: 6 }), true);
  // A later writer that read mine keeps mine in its recent list.
  assert.equal(writeLanded(nextClaims(mine, { action: "land", surface: "mcp" }, "t", "next"), { nonce: "mine", n: 6 }), true);
  // Far past the recent window: assume it landed.
  assert.equal(writeLanded({ lc: { n: 6 + RECENT, r: [] } }, { nonce: "mine", n: 6 }), true);
});
