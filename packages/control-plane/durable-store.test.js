"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryDurableStore, assertDurableStore } = require("./durable-store");

describe("durable store interface", () => {
  it("memory adapter satisfies interface", async () => {
    const store = createMemoryDurableStore({ defaultBalance: 10 });
    assertDurableStore(store);
    assert.equal(store.backend, "memory");
    const ping = await store.ping();
    assert.equal(ping.ok, true);

    store.money.setBalance("w1", 10);
    const r = await store.money.reserve("w1", 3, "d1");
    const rec = store.ledger.create({
      key_id: "k",
      reservation_id: r.id,
      reserved_usd: r.amount_usd,
    });
    store.ledger.transition(rec.id, "reserved");
    store.ledger.finalize(rec.id, { actual_usd: 2 });
    await store.money.reconcile(r.id, 2);
    assert.equal(store.ledger.get(rec.id).status, "finalized");
    assert.equal(store.money.available("w1"), 8);
  });

  it("fail closed: concurrent oversubscribe", async () => {
    const store = createMemoryDurableStore();
    store.money.setBalance("w", 10);
    const results = await Promise.allSettled([
      store.money.reserve("w", 8, "a"),
      store.money.reserve("w", 8, "b"),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  });

  it("assertDurableStore rejects incomplete stores", () => {
    assert.throws(() => assertDurableStore({ ledger: {}, money: {} }), /durable_ledger_missing/);
  });

  it("ping reports unhealthy when configured", async () => {
    const store = createMemoryDurableStore({ healthy: false });
    const ping = await store.ping();
    assert.equal(ping.ok, false);
    assert.equal(ping.reason, "unavailable");
  });
});
