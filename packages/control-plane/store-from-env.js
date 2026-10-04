"use strict";

/**
 * Pick durable backend from env (config over cleverness).
 *
 * Priority:
 *   1. SC_CP_DATABASE_URL / DATABASE_URL → Postgres money (multi-worker safe)
 *   2. SC_CP_DURABLE_DIR → file JSON + cross-process dir lock
 *   3. else → in-memory (tests / ephemeral)
 */

const path = require("path");
const { createMemoryDurableStore } = require("./durable-store");
const {
  createDurableLedgerStore,
  createDurableReservationStore,
} = require("./durable");
const { createPostgresDurableStore } = require("./pg-store");

function createStoreFromEnv(options = {}) {
  const seed =
    options.defaultBalance != null
      ? Number(options.defaultBalance)
      : Number(process.env.SC_CP_WALLET_SEED || 100) || 100;
  const dbUrl =
    options.connectionString ||
    process.env.SC_CP_DATABASE_URL ||
    process.env.DATABASE_URL ||
    "";
  if (dbUrl) {
    return createPostgresDurableStore({
      connectionString: dbUrl,
      pool: options.pool,
      defaultBalance: seed,
    });
  }
  const dir = options.durableDir || process.env.SC_CP_DURABLE_DIR || "";
  if (dir) {
    const root = path.resolve(String(dir));
    return {
      backend: "file",
      ledger: createDurableLedgerStore({ path: path.join(root, "ledger.json") }),
      money: createDurableReservationStore({
        path: path.join(root, "money.json"),
        defaultBalance: seed,
      }),
      async ping() {
        return { ok: true, backend: "file", dir: root };
      },
    };
  }
  return createMemoryDurableStore({ defaultBalance: seed });
}

module.exports = { createStoreFromEnv };
