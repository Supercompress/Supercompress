"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createLedgerStore } = require("./ledger");

describe("cp ledger", () => {
  it("creates and finalizes with lifecycle", () => {
    const ledger = createLedgerStore();
    const rec = ledger.create({ org_id: "o1", key_id: "k1", idempotency_key: "idem-1" });
    assert.equal(rec.status, "created");
    ledger.transition(rec.id, "admitted");
    ledger.transition(rec.id, "compressed", {
      compression: { original_tokens: 10, retained_tokens: 4, unit: "tokens", ratio: 0.4, strategy: "skip", skip_reason: "test" },
    });
    const done = ledger.finalize(rec.id, { actual_usd: 0.01, latency_ms: 12 });
    assert.equal(done.status, "finalized");
    assert.equal(done.actual_usd, 0.01);
  });

  it("idempotent create + finalize", () => {
    const ledger = createLedgerStore();
    const a = ledger.create({ idempotency_key: "x" });
    const b = ledger.create({ idempotency_key: "x" });
    assert.equal(a.id, b.id);
    ledger.finalize(a.id, { error_class: "timeout" });
    const again = ledger.finalize(a.id, { error_class: "error", actual_usd: 9 });
    assert.equal(again.error_class, "timeout");
    assert.equal(again.actual_usd, 9);
  });

  it("mid-fail still finalizes", () => {
    const ledger = createLedgerStore();
    const rec = ledger.create({});
    ledger.transition(rec.id, "attempted");
    const failed = ledger.transition(rec.id, "error", { error_message: "boom" });
    assert.equal(failed.status, "finalized");
    assert.equal(failed.error_class, "error");
  });

  it("rejects regressive transitions", () => {
    const ledger = createLedgerStore();
    const rec = ledger.create({});
    ledger.transition(rec.id, "routed");
    assert.throws(() => ledger.transition(rec.id, "admitted"), /ledger_regress/);
  });
});
