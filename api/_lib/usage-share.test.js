"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mintShareToken, verifyShareToken, accountRef, summarizeUsage } = require("./usage-share");

const S = "x".repeat(40);

test("mint/verify round trip", () => {
  const t = mintShareToken("uid1", "sck_abc", S);
  assert.ok(t.startsWith("scu_"));
  assert.deepEqual(verifyShareToken(t, S), { ownerUid: "uid1", keyId: "sck_abc" });
});

test("rejects tampering, wrong secret, sc_ keys", () => {
  const t = mintShareToken("uid1", "sck_abc", S);
  const forged = "scu_" + Buffer.from(JSON.stringify({ v: 1, u: "uid2", k: "sck_abc" })).toString("base64url") + "." + t.split(".")[1];
  assert.equal(verifyShareToken(forged, S), null);
  assert.equal(verifyShareToken(t, "y".repeat(40)), null);
  assert.equal(verifyShareToken("sc_live_abc", S), null);
  assert.equal(verifyShareToken(undefined, S), null);
});

test("missing secret is a 503", () => {
  const old = process.env.SC_USAGE_SHARE_SECRET;
  delete process.env.SC_USAGE_SHARE_SECRET;
  assert.throws(() => mintShareToken("u", "k"), (e) => e.status === 503);
  if (old !== undefined) process.env.SC_USAGE_SHARE_SECRET = old;
});

test("accountRef is opaque and stable", () => {
  assert.equal(accountRef("uid1", S), accountRef("uid1", S));
  assert.notEqual(accountRef("uid1", S), accountRef("uid2", S));
  assert.ok(!accountRef("uid1", S).includes("uid1"));
});

test("summarize takes max of ledger and agent totals, numbers only", () => {
  const out = summarizeUsage(
    { month: "2026-10", requests: 5, tokens_in: 100, tokens_out: 60, tokens_saved: 40, email: "a@b.c",
      by_day: { "2026-10-01": { tokens_in: 100, tokens_saved: 40, note: "x" }, bad: {} } },
    { codex: { requests: 9, tokens_in: 50, tokens_out: 30, tokens_saved: 20 } }
  );
  assert.equal(out.requests, 9);
  assert.equal(out.tokens_in, 100);
  assert.equal(out.tokens_saved, 40);
  assert.equal(out.email, undefined);
  assert.deepEqual(Object.keys(out.by_day), ["2026-10-01"]);
  assert.equal(out.by_day["2026-10-01"].note, undefined);
  assert.equal(out.agents.codex.tokens_in, 50);
});
