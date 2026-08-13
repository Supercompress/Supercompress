/**
 * Capped compress activity log — previews only, never full dumps.
 *
 * Storage strategy (size-safe):
 *  - Prefer Firestore doc compress_logs/{ownerUid} (ring buffer)
 *  - Fall back to Auth-backed ring on a stub user sc_clog_{hash} customClaims
 *    is too small (1KB), so Auth stub stores a short JSON in displayName? NO.
 *  - Fall back to gist/store compress_logs[ownerUid] with same caps
 *
 * Caps (hard):
 *  - MAX_ENTRIES = 40 per account
 *  - QUERY_MAX = 160 chars
 *  - PREVIEW_MAX = 280 chars (original + compressed each)
 *  ≈ 40 * ~750 bytes ≈ 30KB per user — safe for Firestore/gist
 */

const crypto = require("crypto");
const admin = require("firebase-admin");
const { initFirebaseAdmin } = require("./auth");

const MAX_ENTRIES = 40;
const QUERY_MAX = 160;
const PREVIEW_MAX = 280;
/** Tighter caps when falling back to the monolithic gist/store blob. */
const STORE_MAX_ENTRIES = 20;
const STORE_PREVIEW_MAX = 160;

function auth() {
  if (!initFirebaseAdmin()) {
    const err = new Error("Firebase Admin is not configured");
    err.status = 503;
    throw err;
  }
  return admin.auth();
}

function db() {
  initFirebaseAdmin();
  return admin.firestore();
}

function preview(text, max = PREVIEW_MAX) {
  const s = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (!s) return "";
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

function clipQuery(q) {
  return preview(q, QUERY_MAX);
}

function logUid(ownerUid) {
  const h = crypto.createHash("sha256").update(String(ownerUid)).digest("hex").slice(0, 28);
  return `sc_clog_${h}`;
}

function normalizeEntry(raw = {}, { previewMax = PREVIEW_MAX } = {}) {
  const tokensIn = Math.max(0, Number(raw.tokens_in) || 0);
  const tokensOut = Math.max(0, Number(raw.tokens_out) || 0);
  const tokensSaved = Math.max(
    0,
    Number(raw.tokens_saved) || Math.max(0, tokensIn - tokensOut)
  );
  const pct =
    tokensIn > 0
      ? Math.round((tokensSaved / tokensIn) * 10000) / 100
      : Number(raw.tokens_saved_pct) || 0;
  const latency =
    raw.latency_ms != null && Number.isFinite(Number(raw.latency_ms))
      ? Math.max(0, Math.round(Number(raw.latency_ms)))
      : null;
  return {
    id: String(raw.id || crypto.randomBytes(6).toString("hex")),
    at: raw.at || new Date().toISOString(),
    query: clipQuery(raw.query),
    original_preview: preview(raw.original_preview || raw.original || "", previewMax),
    compressed_preview: preview(raw.compressed_preview || raw.compressed || "", previewMax),
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    tokens_saved: tokensSaved,
    tokens_saved_pct: pct,
    coding_agent: raw.coding_agent
      ? String(raw.coding_agent).toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 40)
      : null,
    key_prefix: raw.key_prefix ? String(raw.key_prefix).slice(0, 16) : null,
    mode: raw.mode ? String(raw.mode).slice(0, 24) : null,
    source: raw.source
      ? String(raw.source).toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 32)
      : null,
    session_id: raw.session_id ? String(raw.session_id).slice(0, 64) : null,
    latency_ms: latency,
  };
}

function pushRing(entries, entry, max = MAX_ENTRIES) {
  const next = [entry, ...(Array.isArray(entries) ? entries : [])];
  return next.slice(0, max);
}

async function appendViaFirestore(ownerUid, entry) {
  const normalized = normalizeEntry(entry);
  const docRef = db().collection("compress_logs").doc(ownerUid);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const prev = snap.exists && Array.isArray(snap.data()?.entries) ? snap.data().entries : [];
    const entries = pushRing(prev, normalized, MAX_ENTRIES);
    tx.set(
      docRef,
      {
        entries,
        updated_at: new Date().toISOString(),
        count: entries.length,
        caps: { max_entries: MAX_ENTRIES, preview_chars: PREVIEW_MAX },
      },
      { merge: true }
    );
  });
  return true;
}

async function loadViaFirestore(ownerUid) {
  const snap = await db().collection("compress_logs").doc(ownerUid).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  return {
    entries: Array.isArray(data.entries) ? data.entries.map(normalizeEntry) : [],
    updated_at: data.updated_at || null,
    storage: "firestore",
  };
}

/**
 * Auth fallback: store ring as a single JSON blob on a disabled Auth stub's
 * customClaims is too small — use Realtime Database-less approach:
 * write claims.sc_clog_head (latest 1 entry) + append via mutateStore instead.
 */
async function appendViaStore(ownerUid, entry) {
  const normalized = normalizeEntry(entry, { previewMax: STORE_PREVIEW_MAX });
  const { mutateStore } = require("./store");
  await mutateStore((store) => {
    if (!store.compress_logs) store.compress_logs = {};
    const prev = store.compress_logs[ownerUid] || { entries: [] };
    const entries = pushRing(prev.entries, normalized, STORE_MAX_ENTRIES);
    store.compress_logs[ownerUid] = {
      entries,
      updated_at: new Date().toISOString(),
      count: entries.length,
      caps: { max_entries: STORE_MAX_ENTRIES, preview_chars: STORE_PREVIEW_MAX },
    };
    return true;
  });
  return true;
}

async function loadViaStore(ownerUid) {
  const { loadStore } = require("./store");
  const store = await loadStore({ forceRemote: true });
  const rec = store.compress_logs?.[ownerUid];
  if (!rec) return { entries: [], updated_at: null, storage: "store" };
  return {
    entries: Array.isArray(rec.entries) ? rec.entries.map(normalizeEntry) : [],
    updated_at: rec.updated_at || null,
    storage: "store",
  };
}

async function appendCompressLog(ownerUid, entry) {
  if (!ownerUid) return { ok: false, reason: "no_owner" };
  const { skipFirestore } = require("./firebase-off");
  if (skipFirestore()) {
    return { ok: false, reason: "firestore_skipped" };
  }
  try {
    await appendViaFirestore(ownerUid, entry);
    return { ok: true, storage: "firestore", entry: normalizeEntry(entry) };
  } catch (err) {
    const msg = String(err.message || "");
    if (
      err.code === 7 ||
      msg.includes("Cloud Firestore API has not been used") ||
      msg.includes("PERMISSION_DENIED")
    ) {
      try {
        await appendViaStore(ownerUid, entry);
        return { ok: true, storage: "store", entry: normalizeEntry(entry, { previewMax: STORE_PREVIEW_MAX }) };
      } catch (storeErr) {
        console.warn("compress-log store append failed:", storeErr.message);
        return { ok: false, reason: storeErr.message };
      }
    }
    console.warn("compress-log firestore append failed:", err.message);
    try {
      await appendViaStore(ownerUid, entry);
      return { ok: true, storage: "store", entry: normalizeEntry(entry, { previewMax: STORE_PREVIEW_MAX }) };
    } catch (storeErr) {
      return { ok: false, reason: storeErr.message };
    }
  }
}

async function listCompressLog(ownerUid, { limit = 40 } = {}) {
  if (!ownerUid) return { entries: [], updated_at: null };
  const { skipFirestore } = require("./firebase-off");
  if (skipFirestore()) {
    return {
      entries: [],
      updated_at: null,
      storage: "skipped",
      caps: { max_entries: MAX_ENTRIES, preview_chars: PREVIEW_MAX },
      note: "Previews only — full dumps are never stored.",
    };
  }
  const lim = Math.max(1, Math.min(MAX_ENTRIES, Number(limit) || MAX_ENTRIES));
  try {
    const fromFs = await loadViaFirestore(ownerUid);
    if (fromFs) {
      return {
        entries: fromFs.entries.slice(0, lim),
        updated_at: fromFs.updated_at,
        storage: fromFs.storage,
        caps: { max_entries: MAX_ENTRIES, preview_chars: PREVIEW_MAX },
        note: "Previews only — full dumps are never stored.",
      };
    }
  } catch (err) {
    console.warn("compress-log firestore read failed:", err.message);
  }
  try {
    const fromStore = await loadViaStore(ownerUid);
    return {
      entries: fromStore.entries.slice(0, lim),
      updated_at: fromStore.updated_at,
      storage: fromStore.storage,
      caps: { max_entries: MAX_ENTRIES, preview_chars: PREVIEW_MAX },
      note: "Previews only — full dumps are never stored.",
    };
  } catch (err) {
    return {
      entries: [],
      updated_at: null,
      storage: "unavailable",
      error: err.message,
      caps: { max_entries: MAX_ENTRIES, preview_chars: PREVIEW_MAX },
    };
  }
}

module.exports = {
  MAX_ENTRIES,
  PREVIEW_MAX,
  QUERY_MAX,
  preview,
  clipQuery,
  appendCompressLog,
  listCompressLog,
  normalizeEntry,
  logUid,
};
