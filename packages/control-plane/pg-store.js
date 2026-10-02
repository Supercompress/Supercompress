"use strict";

/**
 * Postgres-backed durable money store (optional) + memory ledger.
 *
 * Enable with SC_CP_DATABASE_URL=postgres://...
 * Requires the `pg` package at runtime (optional peer).
 * Money ops use SELECT … FOR UPDATE so multi-worker deploys cannot oversubscribe.
 * Ledger stays in-process memory (request rows); swap later if needed.
 */

const { createMemoryDurableStore, assertDurableStore } = require("./durable-store");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sc_cp_wallets (
  wallet_id TEXT PRIMARY KEY,
  balance_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  held_usd DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sc_cp_reservations (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL,
  amount_usd DOUBLE PRECISION NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  state TEXT NOT NULL,
  actual_usd DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL,
  reconciled_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ
);
`;

function newResId() {
  return `rsv_${require("crypto").randomBytes(10).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function mapRes(row) {
  return {
    id: row.id,
    wallet_id: row.wallet_id,
    amount_usd: Number(row.amount_usd),
    idempotency_key: row.idempotency_key,
    state: row.state,
    actual_usd: row.actual_usd != null ? Number(row.actual_usd) : undefined,
    created_at: row.created_at,
    reconciled_at: row.reconciled_at || undefined,
    released_at: row.released_at || undefined,
  };
}

/**
 * @param {{ connectionString?: string, pool?: { connect: Function, query: Function }, defaultBalance?: number }} options
 */
function createPostgresDurableStore(options = {}) {
  const connectionString =
    options.connectionString ||
    process.env.SC_CP_DATABASE_URL ||
    process.env.DATABASE_URL ||
    "";

  let pool = options.pool || null;
  let ready = false;
  let lastError = null;
  const defaultBalance = options.defaultBalance ?? 0;
  const mem = createMemoryDurableStore({ defaultBalance });

  async function getPool() {
    if (pool) return pool;
    if (!connectionString) {
      const err = new Error("sc_cp_database_url_required");
      err.code = "sc_cp_database_url_required";
      throw err;
    }
    let pg;
    try {
      pg = require("pg");
    } catch {
      const err = new Error("pg_package_required");
      err.code = "pg_package_required";
      throw err;
    }
    pool = new pg.Pool({ connectionString, max: 4 });
    return pool;
  }

  async function migrate() {
    const p = await getPool();
    await p.query(SCHEMA_SQL);
    ready = true;
    lastError = null;
  }

  async function ping() {
    try {
      if (!ready) await migrate();
      const p = await getPool();
      await p.query("SELECT 1");
      return { ok: true, backend: "postgres" };
    } catch (err) {
      lastError = String(err.message || err);
      return { ok: false, backend: "postgres", reason: lastError };
    }
  }

  const money = {
    async reserve(walletId, amountUsd, idempotencyKey, seedBalance) {
      const p = await getPool();
      if (!ready) await migrate();
      const key = String(idempotencyKey || "");
      if (!key) {
        const err = new Error("reservation_idempotency_required");
        err.code = "reservation_idempotency_required";
        throw err;
      }
      const amount = Math.round(Number(amountUsd) * 1e6) / 1e6;
      if (!(amount > 0)) {
        const err = new Error("reservation_bad_amount");
        err.code = "reservation_bad_amount";
        throw err;
      }
      const client = await p.connect();
      try {
        await client.query("BEGIN");
        const existing = await client.query(
          "SELECT * FROM sc_cp_reservations WHERE idempotency_key = $1",
          [key]
        );
        if (existing.rows[0]) {
          await client.query("COMMIT");
          return mapRes(existing.rows[0]);
        }
        await client.query(
          `INSERT INTO sc_cp_wallets (wallet_id, balance_usd, held_usd)
           VALUES ($1, $2, 0) ON CONFLICT (wallet_id) DO NOTHING`,
          [String(walletId), Number(seedBalance ?? defaultBalance) || 0]
        );
        const w = await client.query(
          "SELECT * FROM sc_cp_wallets WHERE wallet_id = $1 FOR UPDATE",
          [String(walletId)]
        );
        const wallet = w.rows[0];
        const avail = Number(wallet.balance_usd) - Number(wallet.held_usd);
        if (avail + 1e-9 < amount) {
          await client.query("ROLLBACK");
          const err = new Error("reservation_insufficient_funds");
          err.code = "reservation_insufficient_funds";
          err.available = avail;
          err.requested = amount;
          throw err;
        }
        const id = newResId();
        const created = nowIso();
        await client.query(
          "UPDATE sc_cp_wallets SET held_usd = held_usd + $2 WHERE wallet_id = $1",
          [String(walletId), amount]
        );
        await client.query(
          `INSERT INTO sc_cp_reservations
           (id, wallet_id, amount_usd, idempotency_key, state, created_at)
           VALUES ($1,$2,$3,$4,'held',$5)`,
          [id, String(walletId), amount, key, created]
        );
        await client.query("COMMIT");
        return {
          id,
          wallet_id: String(walletId),
          amount_usd: amount,
          idempotency_key: key,
          state: "held",
          created_at: created,
        };
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw err;
      } finally {
        client.release();
      }
    },

    async reconcile(reservationId, actualUsd) {
      const p = await getPool();
      const client = await p.connect();
      try {
        await client.query("BEGIN");
        const r = await client.query(
          "SELECT * FROM sc_cp_reservations WHERE id = $1 FOR UPDATE",
          [reservationId]
        );
        if (!r.rows[0]) {
          const err = new Error("reservation_not_found");
          err.code = "reservation_not_found";
          throw err;
        }
        const rec = r.rows[0];
        if (rec.state === "reconciled") {
          await client.query("COMMIT");
          return mapRes(rec);
        }
        if (rec.state === "released") {
          const err = new Error("reservation_already_released");
          err.code = "reservation_already_released";
          throw err;
        }
        const actual = Math.round(Number(actualUsd) * 1e6) / 1e6;
        await client.query(
          "SELECT * FROM sc_cp_wallets WHERE wallet_id = $1 FOR UPDATE",
          [rec.wallet_id]
        );
        await client.query(
          `UPDATE sc_cp_wallets
           SET held_usd = GREATEST(held_usd - $2, 0),
               balance_usd = balance_usd - $3
           WHERE wallet_id = $1`,
          [rec.wallet_id, Number(rec.amount_usd), actual]
        );
        const ts = nowIso();
        await client.query(
          `UPDATE sc_cp_reservations
           SET state = 'reconciled', actual_usd = $2, reconciled_at = $3
           WHERE id = $1`,
          [reservationId, actual, ts]
        );
        await client.query("COMMIT");
        return {
          ...mapRes(rec),
          state: "reconciled",
          actual_usd: actual,
          reconciled_at: ts,
        };
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw err;
      } finally {
        client.release();
      }
    },

    async release(reservationId) {
      const p = await getPool();
      const client = await p.connect();
      try {
        await client.query("BEGIN");
        const r = await client.query(
          "SELECT * FROM sc_cp_reservations WHERE id = $1 FOR UPDATE",
          [reservationId]
        );
        if (!r.rows[0]) {
          const err = new Error("reservation_not_found");
          err.code = "reservation_not_found";
          throw err;
        }
        const rec = r.rows[0];
        if (rec.state === "released") {
          await client.query("COMMIT");
          return mapRes(rec);
        }
        if (rec.state === "reconciled") {
          const err = new Error("reservation_already_reconciled");
          err.code = "reservation_already_reconciled";
          throw err;
        }
        await client.query(
          "UPDATE sc_cp_wallets SET held_usd = GREATEST(held_usd - $2, 0) WHERE wallet_id = $1",
          [rec.wallet_id, Number(rec.amount_usd)]
        );
        const ts = nowIso();
        await client.query(
          "UPDATE sc_cp_reservations SET state = 'released', released_at = $2 WHERE id = $1",
          [reservationId, ts]
        );
        await client.query("COMMIT");
        return { ...mapRes(rec), state: "released", released_at: ts };
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw err;
      } finally {
        client.release();
      }
    },

    async get(id) {
      const p = await getPool();
      const r = await p.query("SELECT * FROM sc_cp_reservations WHERE id = $1", [id]);
      return r.rows[0] ? mapRes(r.rows[0]) : null;
    },

    async available(walletId) {
      const p = await getPool();
      const r = await p.query("SELECT * FROM sc_cp_wallets WHERE wallet_id = $1", [
        String(walletId),
      ]);
      if (!r.rows[0]) return 0;
      return (
        Math.round((Number(r.rows[0].balance_usd) - Number(r.rows[0].held_usd)) * 1e6) / 1e6
      );
    },

    async setBalance(walletId, balanceUsd) {
      const p = await getPool();
      await p.query(
        `INSERT INTO sc_cp_wallets (wallet_id, balance_usd, held_usd)
         VALUES ($1, $2, 0)
         ON CONFLICT (wallet_id) DO UPDATE SET balance_usd = EXCLUDED.balance_usd`,
        [String(walletId), Number(balanceUsd)]
      );
      return money.available(walletId);
    },
  };

  const store = {
    backend: "postgres",
    ledger: mem.ledger,
    money,
    ping,
    migrate,
    SCHEMA_SQL,
  };
  assertDurableStore(store);
  return store;
}

module.exports = {
  createPostgresDurableStore,
  SCHEMA_SQL,
};
