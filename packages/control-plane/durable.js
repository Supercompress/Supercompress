"use strict";

/**
 * Durable ledger + reservation stores behind the same Postgres-shaped interface
 * as the in-memory stores. Persist via atomic JSON file write (temp + rename).
 *
 * Fail closed on money — concurrency invariant: two $8 vs $10 → one success.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createLedgerStore } = require("./ledger");
const { withDirLock } = require("./file-lock");

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function atomicWriteJson(filePath, data) {
  ensureDir(filePath);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
  fs.renameSync(tmp, filePath);
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function newResId() {
  return `rsv_${crypto.randomBytes(10).toString("hex")}`;
}

/**
 * @param {{ path: string, autosave?: boolean }} options
 */
function createDurableLedgerStore(options = {}) {
  if (!options.path) {
    const err = new Error("durable_ledger_path_required");
    err.code = "durable_ledger_path_required";
    throw err;
  }
  const filePath = path.resolve(options.path);
  const autosave = options.autosave !== false;
  const mem = createLedgerStore();

  const snap = readJson(filePath, null);
  if (snap && Array.isArray(snap.records)) {
    for (const rec of snap.records) {
      const created = mem.create({
        id: rec.id,
        idempotency_key: rec.idempotency_key,
        org_id: rec.org_id,
        project_id: rec.project_id,
        key_id: rec.key_id,
        agent_id: rec.agent_id,
        reservation_id: rec.reservation_id,
        reserved_usd: rec.reserved_usd,
        model_requested: rec.model_requested,
        compression: rec.compression,
        meta: rec.meta,
      });
      if (!created) continue;
      if (rec.status === "finalized" || rec.error_class) {
        mem.finalize(created.id, {
          actual_usd: rec.actual_usd,
          latency_ms: rec.latency_ms,
          model_routed: rec.model_routed,
          provider: rec.provider,
          compression: rec.compression,
          error_class: rec.error_class,
          error_message: rec.error_message,
        });
      } else if (rec.status && rec.status !== "created") {
        try {
          mem.transition(created.id, rec.status, {
            model_routed: rec.model_routed,
            provider: rec.provider,
            compression: rec.compression,
            reservation_id: rec.reservation_id,
            reserved_usd: rec.reserved_usd,
          });
        } catch {
          /* ignore bad historical order */
        }
      }
    }
  }

  function persist() {
    if (!autosave) return;
    atomicWriteJson(filePath, {
      records: mem.list(),
      saved_at: nowIso(),
    });
  }

  return {
    create(input) {
      const rec = mem.create(input);
      persist();
      return rec;
    },
    transition(id, to, patch) {
      const rec = mem.transition(id, to, patch);
      persist();
      return rec;
    },
    finalize(id, patch) {
      const rec = mem.finalize(id, patch);
      persist();
      return rec;
    },
    get: (id) => mem.get(id),
    list: (filter) => mem.list(filter),
    clear() {
      mem.clear();
      persist();
    },
    persist,
    path: filePath,
    LIFECYCLE: mem.LIFECYCLE,
  };
}

/**
 * @param {{ path: string, autosave?: boolean, defaultBalance?: number }} options
 */
function createDurableReservationStore(options = {}) {
  if (!options.path) {
    const err = new Error("durable_reservation_path_required");
    err.code = "durable_reservation_path_required";
    throw err;
  }
  const filePath = path.resolve(options.path);
  const autosave = options.autosave !== false;

  const wallets = new Map();
  const reservations = new Map();
  const byIdem = new Map();
  let chain = Promise.resolve();
  const lockDir = `${filePath}.lock`;

  function exclusive(fn) {
    const run = chain.then(
      () => withDirLock(lockDir, fn),
      () => withDirLock(lockDir, fn)
    );
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  function persist() {
    if (!autosave) return;
    atomicWriteJson(filePath, {
      wallets: Object.fromEntries([...wallets.entries()].map(([k, v]) => [k, { ...v }])),
      reservations: [...reservations.values()],
      saved_at: nowIso(),
    });
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

  const snap = readJson(filePath, null);
  if (snap?.wallets) {
    for (const [wid, w] of Object.entries(snap.wallets)) {
      wallets.set(wid, {
        balance_usd: Number(w.balance_usd) || 0,
        held_usd: Number(w.held_usd) || 0,
      });
    }
  }
  if (Array.isArray(snap?.reservations)) {
    for (const r of snap.reservations) {
      reservations.set(r.id, { ...r });
      if (r.idempotency_key) byIdem.set(r.idempotency_key, r.id);
    }
  }

  return {
    async reserve(walletId, amountUsd, idempotencyKey, seedBalance) {
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
        persist();
        return { ...rec };
      });
    },

    async reconcile(reservationId, actualUsd) {
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
        persist();
        return { ...rec };
      });
    },

    async release(reservationId) {
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
        persist();
        return { ...rec };
      });
    },

    get(id) {
      const rec = reservations.get(id);
      return rec ? { ...rec } : null;
    },

    available,

    setBalance(walletId, balanceUsd) {
      const w = ensureWallet(walletId);
      w.balance_usd = Number(balanceUsd);
      persist();
      return available(walletId);
    },

    clear() {
      wallets.clear();
      reservations.clear();
      byIdem.clear();
      persist();
    },

    persist,
    path: filePath,
  };
}

function assertLedgerStore(store) {
  for (const m of ["create", "transition", "finalize", "get", "list"]) {
    if (typeof store?.[m] !== "function") {
      const err = new Error(`ledger_store_missing:${m}`);
      err.code = "ledger_store_missing";
      throw err;
    }
  }
  return true;
}

function assertReservationStore(store) {
  for (const m of ["reserve", "reconcile", "release", "get", "available", "setBalance"]) {
    if (typeof store?.[m] !== "function") {
      const err = new Error(`reservation_store_missing:${m}`);
      err.code = "reservation_store_missing";
      throw err;
    }
  }
  return true;
}

module.exports = {
  createDurableLedgerStore,
  createDurableReservationStore,
  assertLedgerStore,
  assertReservationStore,
  atomicWriteJson,
};
