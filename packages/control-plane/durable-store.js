"use strict";

/**
 * Durable store interface (Postgres-shaped).
 *
 * Implementations must expose:
 *   ledger: { create, transition, finalize, get, list, clear? }
 *   money:  { reserve, reconcile, release, get, available, setBalance, clear? }
 *
 * Money.reserve MUST be concurrency-safe: parallel reserves cannot oversubscribe.
 * Fail closed — throw with .code on insufficient funds / bad input.
 */

const { createLedgerStore } = require("./ledger");
const { createReservationStore } = require("./reservation");

/**
 * In-memory durable adapter — same API a Postgres adapter should implement.
 * Use for tests and single-process gateway until a SQL backend is wired.
 *
 * @param {object} [options]
 * @param {ReturnType<typeof createLedgerStore>} [options.ledger]
 * @param {ReturnType<typeof createReservationStore>} [options.money]
 * @param {number} [options.defaultBalance]
 */
function createMemoryDurableStore(options = {}) {
  const ledger = options.ledger || createLedgerStore();
  const money = options.money || createReservationStore({ defaultBalance: options.defaultBalance });

  return {
    backend: "memory",
    ledger,
    money,
    /** Optional health probe for ops — fail closed when unhealthy. */
    async ping() {
      if (options.healthy === false) {
        return { ok: false, backend: "memory", reason: "unavailable" };
      }
      return { ok: true, backend: "memory" };
    },
  };
}

/**
 * Assert a store implements the durable interface (throws on missing methods).
 */
function assertDurableStore(store) {
  if (!store || typeof store !== "object") {
    const err = new Error("durable_store_required");
    err.code = "durable_store_required";
    throw err;
  }
  const ledgerFns = ["create", "transition", "finalize", "get", "list"];
  const moneyFns = ["reserve", "reconcile", "release", "get", "available", "setBalance"];
  for (const fn of ledgerFns) {
    if (typeof store.ledger?.[fn] !== "function") {
      const err = new Error(`durable_ledger_missing:${fn}`);
      err.code = "durable_ledger_missing";
      throw err;
    }
  }
  for (const fn of moneyFns) {
    if (typeof store.money?.[fn] !== "function") {
      const err = new Error(`durable_money_missing:${fn}`);
      err.code = "durable_money_missing";
      throw err;
    }
  }
  return true;
}

module.exports = {
  createMemoryDurableStore,
  assertDurableStore,
};
