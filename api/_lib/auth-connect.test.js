/**
 * Unit tests for Auth-backed API key index helpers (no Firebase required).
 * Run: node api/_lib/auth-connect.test.js
 */
const assert = require("assert");
const { nextOwnerKeyIds, keyLimitReached, keyLimitCap } = require("./auth-connect");

assert.strictEqual(keyLimitCap(10), 10);
assert.strictEqual(keyLimitCap(25), 25);
assert.strictEqual(keyLimitCap(undefined), 20);
assert.strictEqual(keyLimitReached(9, 10), false);
assert.strictEqual(keyLimitReached(10, 10), true);
assert.strictEqual(keyLimitReached(25, 25), true);
assert.strictEqual(keyLimitReached(0, 10), false);

{
  const ids = Array.from({ length: 20 }, (_, i) => `sck_${i}`);
  const next = nextOwnerKeyIds(ids, "sck_new", 25);
  assert.strictEqual(next.length, 21);
  assert.ok(next.includes("sck_new"));
  assert.ok(next.includes("sck_0"));
}

{
  const ids = Array.from({ length: 25 }, (_, i) => `sck_${i}`);
  const next = nextOwnerKeyIds(ids, "sck_new", 25);
  assert.strictEqual(next.length, 25);
  assert.ok(next.includes("sck_new"));
  assert.ok(!next.includes("sck_0"));
}

{
  const ids = Array.from({ length: 9 }, (_, i) => `sck_${i}`);
  const next = nextOwnerKeyIds(ids, "sck_new", 10);
  assert.deepStrictEqual(next[next.length - 1], "sck_new");
  assert.strictEqual(next.length, 10);
}

console.log("auth-connect.test.js: ok");
