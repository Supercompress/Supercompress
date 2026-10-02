"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { withDirLock } = require("./file-lock");
const { createDurableReservationStore } = require("./durable");
const { createPostgresDurableStore } = require("./pg-store");
const { createStoreFromEnv } = require("./store-from-env");

describe("file-lock", () => {
  it("acquires and releases", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-cp-lock-"));
    const lock = path.join(dir, "L.lock");
    const order = [];
    withDirLock(lock, () => order.push(1));
    withDirLock(lock, () => order.push(2));
    assert.deepEqual(order, [1, 2]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("createStoreFromEnv", () => {
  it("defaults to memory", () => {
    const prev = process.env.SC_CP_DURABLE_DIR;
    const prevDb = process.env.SC_CP_DATABASE_URL;
    delete process.env.SC_CP_DURABLE_DIR;
    delete process.env.SC_CP_DATABASE_URL;
    delete process.env.DATABASE_URL;
    const store = createStoreFromEnv({ defaultBalance: 10 });
    assert.equal(store.backend, "memory");
    if (prev != null) process.env.SC_CP_DURABLE_DIR = prev;
    if (prevDb != null) process.env.SC_CP_DATABASE_URL = prevDb;
  });

  it("uses file backend when durableDir set", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-cp-dur-"));
    const store = createStoreFromEnv({ durableDir: dir, defaultBalance: 20 });
    assert.equal(store.backend, "file");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("postgres durable money (mock pool)", () => {
  it("reserves under FOR UPDATE semantics via mock", async () => {
    const wallets = new Map();
    const reservations = new Map();
    const byIdem = new Map();

    function makeClient() {
      return {
        async query(sql, params = []) {
          const s = String(sql).replace(/\s+/g, " ").trim();
          if (s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK") return { rows: [] };
          if (s.includes("INSERT INTO sc_cp_wallets")) {
            const [wid, bal] = params;
            if (!wallets.has(wid)) wallets.set(wid, { balance_usd: bal, held_usd: 0 });
            return { rows: [] };
          }
          if (s.includes("FROM sc_cp_wallets") && s.includes("FOR UPDATE")) {
            const w = wallets.get(params[0]);
            return { rows: w ? [{ wallet_id: params[0], ...w }] : [] };
          }
          if (s.includes("UPDATE sc_cp_wallets SET held_usd = held_usd +")) {
            const w = wallets.get(params[0]);
            w.held_usd += params[1];
            return { rows: [] };
          }
          if (s.includes("INSERT INTO sc_cp_reservations")) {
            const [id, wid, amount, key, created] = params;
            const rec = {
              id,
              wallet_id: wid,
              amount_usd: amount,
              idempotency_key: key,
              state: "held",
              created_at: created,
            };
            reservations.set(id, rec);
            byIdem.set(key, id);
            return { rows: [] };
          }
          if (s.includes("FROM sc_cp_reservations WHERE idempotency_key")) {
            const id = byIdem.get(params[0]);
            return { rows: id ? [reservations.get(id)] : [] };
          }
          if (s.startsWith("CREATE TABLE") || s.includes("CREATE TABLE")) return { rows: [] };
          if (s === "SELECT 1") return { rows: [{ "?column?": 1 }] };
          return { rows: [] };
        },
        release() {},
      };
    }

    const pool = {
      async connect() {
        return makeClient();
      },
      async query(sql, params) {
        return makeClient().query(sql, params);
      },
    };

    const store = createPostgresDurableStore({ pool, defaultBalance: 10 });
    const a = await store.money.reserve("w1", 8, "k1", 10);
    assert.equal(a.state, "held");
    assert.equal(a.amount_usd, 8);
    let denied = false;
    try {
      await store.money.reserve("w1", 8, "k2", 10);
    } catch (err) {
      denied = err.code === "reservation_insufficient_funds";
    }
    assert.equal(denied, true);
    const health = await store.ping();
    assert.equal(health.ok, true);
  });
});

describe("durable reservation cross-process lock smoke", () => {
  it("two sequential reserves against $10", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-cp-money-"));
    const money = createDurableReservationStore({
      path: path.join(dir, "money.json"),
      defaultBalance: 10,
    });
    const a = await money.reserve("w", 8, "a");
    assert.equal(a.state, "held");
    let failed = false;
    try {
      await money.reserve("w", 8, "b");
    } catch (err) {
      failed = err.code === "reservation_insufficient_funds";
    }
    assert.equal(failed, true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
