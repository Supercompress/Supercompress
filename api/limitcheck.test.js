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

const { createHandler } = require("./limitcheck");
const CTX = Symbol.for("@vercel/request-context");

function fakeRes() {
  return {
    headers: {},
    code: null,
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}
const post = (ip) => ({ method: "POST", headers: { "x-forwarded-for": ip }, body: { action: "go", surface: "cli" } });

async function withContext(ctx, fn) {
  const prev = globalThis[CTX];
  globalThis[CTX] = ctx;
  try { return await fn(); } finally { globalThis[CTX] = prev; }
}

test("POST on Vercel replies before the bump settles and hands it to waitUntil", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const handed = [];
  const handler = createHandler({ bump: () => gate });
  const res = fakeRes();
  await withContext({ get: () => ({ waitUntil: (p) => handed.push(p) }) }, () => handler(post("10.0.0.1"), res));
  assert.equal(res.code, 202);
  assert.equal(handed.length, 1);
  let settled = false;
  handed[0].then(() => (settled = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, "bump still running after the reply");
  release();
  await handed[0];
});

test("POST on Vercel: a failed background bump is swallowed, not unhandled", async () => {
  const handed = [];
  const handler = createHandler({ bump: () => Promise.reject(new Error("boom")) });
  const res = fakeRes();
  await withContext({ get: () => ({ waitUntil: (p) => handed.push(p) }) }, () => handler(post("10.0.0.2"), res));
  assert.equal(res.code, 202);
  await handed[0]; // resolves: the rejection was caught
});

test("POST off Vercel waits for the bump and reports failure as 503", async () => {
  let done = false;
  const ok = createHandler({ bump: () => new Promise((r) => setTimeout(() => { done = true; r(); }, 20)) });
  const res = fakeRes();
  await withContext(undefined, () => ok(post("10.0.0.3"), res));
  assert.equal(done, true);
  assert.equal(res.code, 202);

  const bad = createHandler({ bump: () => Promise.reject(new Error("boom")) });
  const res2 = fakeRes();
  await withContext(undefined, () => bad(post("10.0.0.4"), res2));
  assert.equal(res2.code, 503);
});

test("POST on Fly replies before the bump settles", async () => {
  const prev = process.env.FLY_APP_NAME;
  process.env.FLY_APP_NAME = "supercompress-api";
  try {
    let release;
    const slow = createHandler({ bump: () => new Promise((r) => { release = r; }) });
    const res = fakeRes();
    await withContext(undefined, () => slow(post("10.0.0.9"), res));
    assert.equal(res.code, 202);
    release();
  } finally {
    if (prev === undefined) delete process.env.FLY_APP_NAME; else process.env.FLY_APP_NAME = prev;
  }
});
