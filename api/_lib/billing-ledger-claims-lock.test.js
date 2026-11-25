"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// Fake Firebase Auth with async latency so unserialized read-modify-write races.
const users = new Map();
const tick = () => new Promise((r) => setTimeout(r, Math.random() * 4));
const fakeAuth = {
  async getUser(uid) {
    await tick();
    const u = users.get(uid) || { uid, customClaims: {} };
    users.set(uid, u);
    return { uid, customClaims: { ...(u.customClaims || {}) } };
  },
  async setCustomUserClaims(uid, claims) {
    await tick();
    users.get(uid).customClaims = { ...claims };
  },
};
require.cache[require.resolve("firebase-admin")] = {
  id: "firebase-admin",
  filename: require.resolve("firebase-admin"),
  loaded: true,
  exports: { auth: () => fakeAuth, apps: [] },
};

const { patchUserClaims } = require("./billing-ledger");

test("parallel same-user claims patches all land (no claims_patch_conflict)", async () => {
  users.set("u1", { uid: "u1", customClaims: { n: 0 } });
  const results = await Promise.allSettled(
    Array.from({ length: 40 }, () =>
      patchUserClaims("u1", (c) => ({ ...c, n: Number(c.n || 0) + 1 }))
    )
  );
  assert.deepEqual(results.filter((r) => r.status === "rejected").map((r) => r.reason?.message), []);
  assert.equal(users.get("u1").customClaims.n, 40);
});

test("different users are not serialized behind each other", async () => {
  users.set("a", { uid: "a", customClaims: {} });
  users.set("b", { uid: "b", customClaims: {} });
  const [a, b] = await Promise.all([
    patchUserClaims("a", (c) => ({ ...c, x: 1 })),
    patchUserClaims("b", (c) => ({ ...c, x: 2 })),
  ]);
  assert.equal(a.x, 1);
  assert.equal(b.x, 2);
});

test("a failing mutator does not wedge the user's queue", async () => {
  users.set("c", { uid: "c", customClaims: {} });
  await assert.rejects(patchUserClaims("c", () => null));
  const after = await patchUserClaims("c", (cl) => ({ ...cl, ok: true }));
  assert.equal(after.ok, true);
});
