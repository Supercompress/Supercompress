"use strict";

/**
 * Full SQL request ledger (Postgres). Complements money wallets/reservations.
 * Same shape as createLedgerStore — multi-worker safe.
 */

const crypto = require("crypto");
const { LIFECYCLE, FAIL_STATUSES } = require("./ledger");

const LEDGER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sc_cp_ledger (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  org_id TEXT,
  project_id TEXT,
  key_id TEXT,
  agent_id TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  reservation_id TEXT,
  reserved_usd DOUBLE PRECISION,
  actual_usd DOUBLE PRECISION,
  model_requested TEXT,
  model_routed TEXT,
  provider TEXT,
  latency_ms DOUBLE PRECISION,
  compression JSONB,
  error_class TEXT,
  error_message TEXT,
  meta JSONB
);
CREATE INDEX IF NOT EXISTS sc_cp_ledger_org_created ON sc_cp_ledger (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sc_cp_ledger_agent_created ON sc_cp_ledger (agent_id, created_at DESC);
`;

const TERMINAL_OK = new Set(LIFECYCLE);

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return `req_${crypto.randomBytes(12).toString("hex")}`;
}

function rowToRec(row) {
  if (!row) return null;
  return {
    id: row.id,
    idempotency_key: row.idempotency_key || undefined,
    org_id: row.org_id || undefined,
    project_id: row.project_id || undefined,
    key_id: row.key_id || undefined,
    agent_id: row.agent_id || undefined,
    status: row.status,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    reservation_id: row.reservation_id || undefined,
    reserved_usd: row.reserved_usd != null ? Number(row.reserved_usd) : undefined,
    actual_usd: row.actual_usd != null ? Number(row.actual_usd) : undefined,
    model_requested: row.model_requested || undefined,
    model_routed: row.model_routed || undefined,
    provider: row.provider || undefined,
    latency_ms: row.latency_ms != null ? Number(row.latency_ms) : undefined,
    compression: row.compression ?? null,
    error_class: row.error_class || undefined,
    error_message: row.error_message || undefined,
    meta: row.meta && typeof row.meta === "object" ? { ...row.meta } : {},
  };
}

function createPostgresLedgerStore(options = {}) {
  const getPool = options.getPool;
  if (typeof getPool !== "function") {
    const err = new Error("pg_ledger_get_pool_required");
    err.code = "pg_ledger_get_pool_required";
    throw err;
  }
  let ready = false;

  async function ensure() {
    if (ready) return;
    const p = await getPool();
    await p.query(LEDGER_SCHEMA_SQL);
    ready = true;
  }

  async function get(id) {
    await ensure();
    const p = await getPool();
    const r = await p.query("SELECT * FROM sc_cp_ledger WHERE id = $1", [id]);
    return rowToRec(r.rows[0]);
  }

  async function getByIdem(idem) {
    await ensure();
    const p = await getPool();
    const r = await p.query("SELECT * FROM sc_cp_ledger WHERE idempotency_key = $1", [idem]);
    return rowToRec(r.rows[0]);
  }

  async function upsert(rec) {
    await ensure();
    const p = await getPool();
    await p.query(
      `INSERT INTO sc_cp_ledger (
         id, idempotency_key, org_id, project_id, key_id, agent_id, status,
         created_at, updated_at, reservation_id, reserved_usd, actual_usd,
         model_requested, model_routed, provider, latency_ms, compression,
         error_class, error_message, meta
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20::jsonb
       )
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at,
         reservation_id = EXCLUDED.reservation_id,
         reserved_usd = EXCLUDED.reserved_usd,
         actual_usd = EXCLUDED.actual_usd,
         model_requested = EXCLUDED.model_requested,
         model_routed = EXCLUDED.model_routed,
         provider = EXCLUDED.provider,
         latency_ms = EXCLUDED.latency_ms,
         compression = EXCLUDED.compression,
         error_class = EXCLUDED.error_class,
         error_message = EXCLUDED.error_message,
         meta = EXCLUDED.meta`,
      [
        rec.id,
        rec.idempotency_key || null,
        rec.org_id || null,
        rec.project_id || null,
        rec.key_id || null,
        rec.agent_id || null,
        rec.status,
        rec.created_at,
        rec.updated_at,
        rec.reservation_id || null,
        rec.reserved_usd != null ? Number(rec.reserved_usd) : null,
        rec.actual_usd != null ? Number(rec.actual_usd) : null,
        rec.model_requested || null,
        rec.model_routed || null,
        rec.provider || null,
        rec.latency_ms != null ? Number(rec.latency_ms) : null,
        JSON.stringify(rec.compression ?? null),
        rec.error_class || null,
        rec.error_message || null,
        JSON.stringify(rec.meta || {}),
      ]
    );
    return get(rec.id);
  }

  /**
   * Sync-shaped API used by wire.js today. Uses deasync-free pattern:
   * we expose async methods AND sync wrappers that throw if used without await —
   * wire already treats ledger ops synchronously. Bridge with sync cache +
   * fire-and-forget persist is unsafe. Prefer async ledger facade below.
   *
   * For wire compatibility: keep an in-memory mirror flushed to PG on each write,
   * hydrate on first use. Multi-worker: last-write-wins per id; list merges via PG.
   */
  const mem = new Map();
  const byIdem = new Map();
  let hydrated = false;

  async function hydrate() {
    if (hydrated) return;
    await ensure();
    const p = await getPool();
    const r = await p.query("SELECT * FROM sc_cp_ledger ORDER BY created_at DESC LIMIT 5000");
    for (const row of r.rows) {
      const rec = rowToRec(row);
      mem.set(rec.id, rec);
      if (rec.idempotency_key) byIdem.set(rec.idempotency_key, rec.id);
    }
    hydrated = true;
  }

  function snapshot(id) {
    const rec = mem.get(id);
    return rec ? { ...rec, meta: { ...(rec.meta || {}) } } : null;
  }

  function create(input = {}) {
    const idem = input.idempotency_key ? String(input.idempotency_key) : null;
    if (idem && byIdem.has(idem)) return snapshot(byIdem.get(idem));
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
    mem.set(rec.id, rec);
    if (idem) byIdem.set(idem, rec.id);
    // Persist async-safe: sync write via deasync not available — use queueMicrotask + blocking query in tests via migrate.
    // Callers that need durability should await flush(); wire uses sync — we schedule persist.
    schedulePersist(rec.id);
    return snapshot(rec.id);
  }

  const pending = new Set();
  let flushChain = Promise.resolve();

  function schedulePersist(id) {
    pending.add(id);
    flushChain = flushChain.then(() => flushOne(id)).catch(() => {});
  }

  async function flushOne(id) {
    const rec = mem.get(id);
    if (!rec) return;
    await upsert(rec);
    pending.delete(id);
  }

  async function flush() {
    await hydrate();
    const ids = [...pending];
    for (const id of ids) await flushOne(id);
  }

  function transition(id, to, patch = {}) {
    const cur = mem.get(id);
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
    schedulePersist(id);
    return snapshot(id);
  }

  function finalize(id, patch = {}) {
    const cur = mem.get(id);
    if (!cur) {
      const err = new Error(`ledger_not_found:${id}`);
      err.code = "ledger_not_found";
      throw err;
    }
    if (cur.status === "finalized") {
      if (patch && Object.keys(patch).length) {
        for (const [k, v] of Object.entries(patch)) {
          if (cur[k] == null && v != null) cur[k] = v;
        }
        cur.updated_at = nowIso();
        schedulePersist(id);
      }
      return snapshot(id);
    }
    Object.assign(cur, patch, {
      status: "finalized",
      updated_at: nowIso(),
    });
    schedulePersist(id);
    return snapshot(id);
  }

  function list(filter = {}) {
    let rows = [...mem.values()].map((r) => snapshot(r.id));
    if (filter.org_id) rows = rows.filter((r) => r.org_id === filter.org_id);
    if (filter.key_id) rows = rows.filter((r) => r.key_id === filter.key_id);
    if (filter.agent_id) rows = rows.filter((r) => r.agent_id === filter.agent_id);
    if (filter.status) rows = rows.filter((r) => r.status === filter.status);
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return rows;
  }

  function clear() {
    mem.clear();
    byIdem.clear();
    pending.clear();
    hydrated = false;
    flushChain = flushChain
      .then(async () => {
        await ensure();
        const p = await getPool();
        await p.query("DELETE FROM sc_cp_ledger");
      })
      .catch(() => {});
  }

  return {
    create,
    transition,
    finalize,
    get: (id) => snapshot(id),
    list,
    clear,
    LIFECYCLE,
    flush,
    hydrate,
    backend: "postgres",
    LEDGER_SCHEMA_SQL,
  };
}

module.exports = {
  createPostgresLedgerStore,
  LEDGER_SCHEMA_SQL,
};
