"use strict";

const crypto = require("crypto");

function nowIso() {
  return new Date().toISOString();
}

function newResId() {
  return `rsv_${crypto.randomBytes(10).toString("hex")}`;
}

/**
 * In-memory wallet + reservation store with atomic reserve under concurrency.
 * Concurrency invariant: two parallel $8 reserves against $10 → exactly one succeeds.
 */
function createReservationStore(options = {}) {
  /** wallet_id → { balance_usd, held_usd } */
  const wallets = new Map();
  /** reservation_id → Reservation */
  const reservations = new Map();
  /** idempotency_key → reservation_id */
  const byIdem = new Map();

  // Simple mutex queue for atomic sections (single-process)
  let chain = Promise.resolve();
  function exclusive(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  function ensureWallet(walletId, seedBalance) {
    if (!wallets.has(walletId)) {
      wallets.set(walletId, {
        balance_usd: Number(seedBalance ?? options.defaultBalance ?? 0),
        held_usd: 0,
      });
    }
    return wallets.get(walletId);
  }

  function available(walletId) {
    const w = ensureWallet(walletId);
    return Math.round((w.balance_usd - w.held_usd) * 1e6) / 1e6;
  }

  function setBalance(walletId, balanceUsd) {
    const w = ensureWallet(walletId);
    w.balance_usd = Number(balanceUsd);
    return available(walletId);
  }

  async function reserve(walletId, amountUsd, idempotencyKey, seedBalance) {
    return exclusive(() => {
      const key = String(idempotencyKey || "");
      if (!key) {
        const err = new Error("reservation_idempotency_required");
        err.code = "reservation_idempotency_required";
        throw err;
      }
      if (byIdem.has(key)) {
        return { ...reservations.get(byIdem.get(key)) };
      }
      const amount = Math.round(Number(amountUsd) * 1e6) / 1e6;
      if (!(amount > 0)) {
        const err = new Error("reservation_bad_amount");
        err.code = "reservation_bad_amount";
        throw err;
      }
      ensureWallet(walletId, seedBalance);
      const avail = available(walletId);
      if (avail + 1e-9 < amount) {
        const err = new Error("reservation_insufficient_funds");
        err.code = "reservation_insufficient_funds";
        err.available = avail;
        err.requested = amount;
        throw err;
      }
      const w = wallets.get(walletId);
      w.held_usd = Math.round((w.held_usd + amount) * 1e6) / 1e6;
      const rec = {
        id: newResId(),
        wallet_id: String(walletId),
        amount_usd: amount,
        idempotency_key: key,
        state: "held",
        created_at: nowIso(),
      };
      reservations.set(rec.id, rec);
      byIdem.set(key, rec.id);
      return { ...rec };
    });
  }

  async function reconcile(reservationId, actualUsd) {
    return exclusive(() => {
      const rec = reservations.get(reservationId);
      if (!rec) {
        const err = new Error("reservation_not_found");
        err.code = "reservation_not_found";
        throw err;
      }
      if (rec.state === "reconciled") return { ...rec };
      if (rec.state === "released") {
        const err = new Error("reservation_already_released");
        err.code = "reservation_already_released";
        throw err;
      }
      const actual = Math.round(Number(actualUsd) * 1e6) / 1e6;
      if (!(actual >= 0)) {
        const err = new Error("reservation_bad_actual");
        err.code = "reservation_bad_actual";
        throw err;
      }
      const w = ensureWallet(rec.wallet_id);
      w.held_usd = Math.round((w.held_usd - rec.amount_usd) * 1e6) / 1e6;
      if (w.held_usd < 0) w.held_usd = 0;
      w.balance_usd = Math.round((w.balance_usd - actual) * 1e6) / 1e6;
      rec.state = "reconciled";
      rec.actual_usd = actual;
      rec.reconciled_at = nowIso();
      return { ...rec };
    });
  }

  async function release(reservationId) {
    return exclusive(() => {
      const rec = reservations.get(reservationId);
      if (!rec) {
        const err = new Error("reservation_not_found");
        err.code = "reservation_not_found";
        throw err;
      }
      if (rec.state === "released") return { ...rec };
      if (rec.state === "reconciled") {
        const err = new Error("reservation_already_reconciled");
        err.code = "reservation_already_reconciled";
        throw err;
      }
      const w = ensureWallet(rec.wallet_id);
      w.held_usd = Math.round((w.held_usd - rec.amount_usd) * 1e6) / 1e6;
      if (w.held_usd < 0) w.held_usd = 0;
      rec.state = "released";
      rec.released_at = nowIso();
      return { ...rec };
    });
  }

  function get(id) {
    const rec = reservations.get(id);
    return rec ? { ...rec } : null;
  }

  function clear() {
    wallets.clear();
    reservations.clear();
    byIdem.clear();
  }

  return {
    reserve,
    reconcile,
    release,
    get,
    available,
    setBalance,
    clear,
  };
}

module.exports = { createReservationStore };
