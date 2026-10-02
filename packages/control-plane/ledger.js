"use strict";

const crypto = require("crypto");

const LIFECYCLE = [
  "created",
  "admitted",
  "reserved",
  "compressed",
  "routed",
  "attempted",
  "streamed",
  "finalized",
];

const TERMINAL_OK = new Set(LIFECYCLE);
const FAIL_STATUSES = new Set(["error", "rejected", "timeout", "cancelled"]);

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return `req_${crypto.randomBytes(12).toString("hex")}`;
}

/**
 * In-memory request ledger (Postgres-shaped API).
 * Failures may jump to finalized with error_class set.
 */
function createLedgerStore(options = {}) {
  const records = new Map();
  const byIdempotency = new Map();

  function get(id) {
    const rec = records.get(id);
    return rec ? { ...rec, meta: { ...(rec.meta || {}) } } : null;
  }

  function getByIdempotency(key) {
    if (!key) return null;
    const id = byIdempotency.get(String(key));
    return id ? get(id) : null;
  }

  function create(input = {}) {
    const idem = input.idempotency_key ? String(input.idempotency_key) : null;
    if (idem && byIdempotency.has(idem)) {
      return get(byIdempotency.get(idem));
    }
    const ts = nowIso();
    const rec = {
      id: input.id || newId(),
      idempotency_key: idem || undefined,
      org_id: input.org_id,
      project_id: input.project_id,
      key_id: input.key_id,
      agent_id: input.agent_id,
      status: "created",
      created_at: ts,
      updated_at: ts,
      reservation_id: input.reservation_id,
      reserved_usd: input.reserved_usd,
      actual_usd: undefined,
      model_requested: input.model_requested,
      model_routed: undefined,
      provider: undefined,
      latency_ms: undefined,
      compression: input.compression ?? null,
      error_class: undefined,
      error_message: undefined,
      meta: { ...(input.meta || {}) },
    };
    records.set(rec.id, rec);
    if (idem) byIdempotency.set(idem, rec.id);
    return get(rec.id);
  }

  function transition(id, to, patch = {}) {
    const cur = records.get(id);
    if (!cur) {
      const err = new Error(`ledger_not_found:${id}`);
      err.code = "ledger_not_found";
      throw err;
    }
    if (cur.status === "finalized") {
      const err = new Error("ledger_already_finalized");
      err.code = "ledger_already_finalized";
      throw err;
    }
    const nextStatus = String(to || "");
    if (!TERMINAL_OK.has(nextStatus) && !FAIL_STATUSES.has(nextStatus)) {
      const err = new Error(`ledger_bad_status:${nextStatus}`);
      err.code = "ledger_bad_status";
      throw err;
    }
    // Allow forward moves or jump to finalized / fail statuses
    if (nextStatus !== "finalized" && !FAIL_STATUSES.has(nextStatus)) {
      const fromIdx = LIFECYCLE.indexOf(cur.status);
      const toIdx = LIFECYCLE.indexOf(nextStatus);
      if (toIdx < fromIdx) {
        const err = new Error(`ledger_regress:${cur.status}->${nextStatus}`);
        err.code = "ledger_regress";
        throw err;
      }
    }
    Object.assign(cur, patch, {
      status: FAIL_STATUSES.has(nextStatus) ? "finalized" : nextStatus,
      updated_at: nowIso(),
    });
    if (FAIL_STATUSES.has(nextStatus) && !cur.error_class) {
      cur.error_class = nextStatus;
    }
    return get(id);
  }

  function finalize(id, patch = {}) {
    const cur = records.get(id);
    if (!cur) {
      const err = new Error(`ledger_not_found:${id}`);
      err.code = "ledger_not_found";
      throw err;
    }
    if (cur.status === "finalized") {
      // idempotent finalize
      if (patch && Object.keys(patch).length) {
        // keep first terminal truth; only fill undefined fields
        for (const [k, v] of Object.entries(patch)) {
          if (cur[k] == null && v != null) cur[k] = v;
        }
        cur.updated_at = nowIso();
      }
      return get(id);
    }
    Object.assign(cur, patch, {
      status: "finalized",
      updated_at: nowIso(),
    });
    return get(id);
  }

  function list(filter = {}) {
    let rows = [...records.values()].map((r) => get(r.id));
    if (filter.org_id) rows = rows.filter((r) => r.org_id === filter.org_id);
    if (filter.key_id) rows = rows.filter((r) => r.key_id === filter.key_id);
    if (filter.agent_id) rows = rows.filter((r) => r.agent_id === filter.agent_id);
    if (filter.status) rows = rows.filter((r) => r.status === filter.status);
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return rows;
  }

  function clear() {
    records.clear();
    byIdempotency.clear();
  }

  return {
    create,
    transition,
    finalize,
    get,
    getByIdempotency,
    list,
    clear,
    LIFECYCLE,
  };
}

module.exports = {
  createLedgerStore,
  LIFECYCLE,
  FAIL_STATUSES,
};
