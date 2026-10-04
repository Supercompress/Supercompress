"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createDurableLedgerStore,
  createDurableReservationStore,
  assertLedgerStore,
  assertReservationStore,
} = require("./durable");

describe("durable stores", () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-durable-"));
  });
  after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("ledger persists across reopen", () => {
    const p = path.join(dir, "ledger.json");
    const a = createDurableLedgerStore({ path: p });
    assertLedgerStore(a);
    const rec = a.create({ org_id: "o1", key_id: "k1", model_requested: "gpt-4o-mini" });
    a.transition(rec.id, "compressed", {
      compression: { original_tokens: 100, retained_tokens: 40, strategy: "unknown" },
    });
    a.finalize(rec.id, { actual_usd: 0.01, provider: "openai" });

    const b = createDurableLedgerStore({ path: p });
    const got = b.get(rec.id);
    assert.equal(got.status, "finalized");
    assert.equal(got.provider, "openai");
    assert.equal(got.compression.retained_tokens, 40);
  });

  it("reservation concurrency + persist held", async () => {
    const p = path.join(dir, "money.json");
    const money = createDurableReservationStore({ path: p });
    assertReservationStore(money);
    money.setBalance("w1", 10);
    const results = await Promise.allSettled([
      money.reserve("w1", 8, "c1"),
      money.reserve("w1", 8, "c2"),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);

    const reopened = createDurableReservationStore({ path: p });
    assert.equal(reopened.available("w1"), 2);
    const held = results.find((r) => r.status === "fulfilled").value;
    assert.equal(reopened.get(held.id).state, "held");
  });

  it("assert helpers reject incomplete stores", () => {
    assert.throws(() => assertLedgerStore({}), /ledger_store_missing/);
    assert.throws(() => assertReservationStore({}), /reservation_store_missing/);
  });
});
