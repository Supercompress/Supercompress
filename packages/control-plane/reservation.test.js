"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createReservationStore } = require("./reservation");

describe("budget reservation", () => {
  it("reserves and reconciles", async () => {
    const money = createReservationStore();
    money.setBalance("w1", 10);
    const r = await money.reserve("w1", 3, "idem-a");
    assert.equal(r.state, "held");
    assert.equal(money.available("w1"), 7);
    await money.reconcile(r.id, 2.5);
    assert.equal(money.available("w1"), 7.5);
  });

  it("releases hold on failure", async () => {
    const money = createReservationStore();
    money.setBalance("w1", 10);
    const r = await money.reserve("w1", 4, "idem-b");
    await money.release(r.id);
    assert.equal(money.available("w1"), 10);
  });

  it("concurrency: two $8 vs $10 → exactly one succeeds", async () => {
    const money = createReservationStore();
    money.setBalance("w1", 10);
    const results = await Promise.allSettled([
      money.reserve("w1", 8, "c1"),
      money.reserve("w1", 8, "c2"),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected");
    assert.equal(ok.length, 1);
    assert.equal(bad.length, 1);
    assert.equal(bad[0].reason.code, "reservation_insufficient_funds");
    assert.equal(money.available("w1"), 2);
  });

  it("idempotent reserve", async () => {
    const money = createReservationStore();
    money.setBalance("w1", 10);
    const a = await money.reserve("w1", 1, "same");
    const b = await money.reserve("w1", 1, "same");
    assert.equal(a.id, b.id);
    assert.equal(money.available("w1"), 9);
  });
});
