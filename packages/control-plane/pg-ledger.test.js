"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createPostgresLedgerStore } = require("./pg-ledger");

function mockPool() {
  const rowsById = new Map();
  const byIdem = new Map();

  async function query(sql, params = []) {
    const s = String(sql);
    if (s.includes("CREATE TABLE") || s.includes("CREATE INDEX")) {
      return { rows: [] };
    }
    if (s.includes("SELECT * FROM sc_cp_ledger WHERE id")) {
      const rec = rowsById.get(params[0]);
      return { rows: rec ? [rec] : [] };
    }
    if (s.includes("SELECT * FROM sc_cp_ledger WHERE idempotency_key")) {
      const id = byIdem.get(params[0]);
      const rec = id ? rowsById.get(id) : null;
      return { rows: rec ? [rec] : [] };
    }
    if (s.includes("SELECT * FROM sc_cp_ledger ORDER BY")) {
      return { rows: [...rowsById.values()] };
    }
    if (s.includes("INSERT INTO sc_cp_ledger")) {
      const rec = {
        id: params[0],
        idempotency_key: params[1],
        org_id: params[2],
        project_id: params[3],
        key_id: params[4],
        agent_id: params[5],
        status: params[6],
        created_at: params[7],
        updated_at: params[8],
        reservation_id: params[9],
        reserved_usd: params[10],
        actual_usd: params[11],
        model_requested: params[12],
        model_routed: params[13],
        provider: params[14],
        latency_ms: params[15],
        compression: JSON.parse(params[16] || "null"),
        error_class: params[17],
        error_message: params[18],
        meta: JSON.parse(params[19] || "{}"),
      };
      rowsById.set(rec.id, rec);
      if (rec.idempotency_key) byIdem.set(rec.idempotency_key, rec.id);
      return { rows: [] };
    }
    if (s.includes("DELETE FROM sc_cp_ledger")) {
      rowsById.clear();
      byIdem.clear();
      return { rows: [] };
    }
    return { rows: [] };
  }

  return {
    async query(sql, params) {
      return query(sql, params);
    },
    async connect() {
      return {
        query,
        release() {},
      };
    },
    _rowsById: rowsById,
  };
}

describe("postgres ledger", () => {
  it("create → transition → finalize persists via flush", async () => {
    const pool = mockPool();
    const ledger = createPostgresLedgerStore({ getPool: async () => pool });
    await ledger.hydrate();
    const rec = ledger.create({
      org_id: "o1",
      key_id: "k1",
      idempotency_key: "idem-1",
      model_requested: "gpt-4o-mini",
      compression: { original_tokens: 100, retained_tokens: 40 },
    });
    assert.equal(rec.status, "created");
    ledger.transition(rec.id, "routed", { model_routed: "gpt-4o-mini" });
    ledger.finalize(rec.id, {
      actual_usd: 0.01,
      compression: {
        original_tokens: 100,
        retained_tokens: 40,
        meta: { economics: { dollars_saved_est: 0.02, model_changed: true } },
      },
    });
    await ledger.flush();
    assert.equal(pool._rowsById.size, 1);
    const stored = [...pool._rowsById.values()][0];
    assert.equal(stored.status, "finalized");
    assert.equal(Number(stored.actual_usd), 0.01);
    assert.equal(stored.compression.meta.economics.model_changed, true);
  });

  it("idempotent create returns same row", async () => {
    const pool = mockPool();
    const ledger = createPostgresLedgerStore({ getPool: async () => pool });
    const a = ledger.create({ idempotency_key: "same", key_id: "k" });
    const b = ledger.create({ idempotency_key: "same", key_id: "k" });
    assert.equal(a.id, b.id);
  });
});
