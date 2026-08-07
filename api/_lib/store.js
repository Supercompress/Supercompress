/**
 * Persistent key + usage store backed by Firestore (via Firebase Admin SDK).
 *
 * Replaces the previous Vercel Blob implementation, which was unreliable due to
 * Hobby-plan store limits and stale tokens. Firestore is already configured for
 * this project and offers generous free-tier usage.
 *
 * store document: config/store (single Firestore document, <1 MB for now).
 *
 * The in-memory write-through cache keeps hot-path reads fast within a single
 * warm lambda invocation.  Firestore transactions give us atomic read-modify-write
 * for mutateStore, so the manual version-based conflict resolution is gone.
 */

const { initFirebaseAdmin } = require("./auth");
const crypto = require("crypto");
const { gistConfigured, loadGistStore, saveGistStore } = require("./gist-store");

let /** @type {import("firebase-admin").firestore.Firestore | null} */ _db = null;

/** In-process write-through cache — same warm lambda sees updates immediately. */
let writeCache = null;
let firestoreUnavailable = false;
let useGistStore = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function db() {
  if (!_db) {
    initFirebaseAdmin();
    _db = require("firebase-admin").firestore();
  }
  return _db;
}

function emptyStore() {
  return {
    keys: {},
    hash_index: {},
    usage: {},
    subscriptions: {},
    affiliates: {},
    affiliate_tracking: {},
    affiliate_conversions: {},
    connections: {},
    coding_agent_usage: {},
    welcome_emails: {},
    weekly_emails: {},
    weekly_unsubscribes: {},
    _version: 0,
  };
}

function cloneStore(raw) {
  return JSON.parse(JSON.stringify(raw));
}

function normalizeStore(raw) {
  if (!raw || typeof raw !== "object") return emptyStore();
  return {
    keys: raw.keys && typeof raw.keys === "object" ? raw.keys : {},
    hash_index: raw.hash_index && typeof raw.hash_index === "object" ? raw.hash_index : {},
    usage: raw.usage && typeof raw.usage === "object" ? raw.usage : {},
    subscriptions: raw.subscriptions && typeof raw.subscriptions === "object" ? raw.subscriptions : {},
    affiliates: raw.affiliates && typeof raw.affiliates === "object" ? raw.affiliates : {},
    affiliate_tracking: raw.affiliate_tracking && typeof raw.affiliate_tracking === "object" ? raw.affiliate_tracking : {},
    affiliate_conversions: raw.affiliate_conversions && typeof raw.affiliate_conversions === "object" ? raw.affiliate_conversions : {},
    connections: raw.connections && typeof raw.connections === "object" ? raw.connections : {},
    coding_agent_usage: raw.coding_agent_usage && typeof raw.coding_agent_usage === "object" ? raw.coding_agent_usage : {},
    welcome_emails: raw.welcome_emails && typeof raw.welcome_emails === "object" ? raw.welcome_emails : {},
    weekly_emails: raw.weekly_emails && typeof raw.weekly_emails === "object" ? raw.weekly_emails : {},
    weekly_unsubscribes: raw.weekly_unsubscribes && typeof raw.weekly_unsubscribes === "object" ? raw.weekly_unsubscribes : {},
    _version: typeof raw._version === "number" ? raw._version : 0,
    _updated_at: raw._updated_at || null,
  };
}

function storageError() {
  const err = new Error("Persistent storage is unavailable. Check Firebase Admin credentials and storage status.");
  err.status = 503;
  return err;
}

function isFirestoreUnavailable(err) {
  const msg = String(err?.message || "");
  return (
    err?.code === 7 ||
    msg.includes("Cloud Firestore API has not been used") ||
    msg.includes("Could not load the default credentials")
  );
}

function auth() {
  if (!initFirebaseAdmin()) throw storageError();
  return require("firebase-admin").auth();
}

function recordUid(type, id) {
  if (type === "affiliate" && /^[a-zA-Z0-9_-]{1,110}$/.test(id)) {
    return `sc_aff_${id}`;
  }
  const hash = crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 48);
  return type === "tracking" ? `sc_at_${hash}` : `sc_ac_${hash}`;
}

function compactRecord(type, id, data) {
  if (type === "tracking") {
    return {
      id,
      ref: data.ref || "",
      ip: data.ip || "",
      page: String(data.page || "/").slice(0, 120),
      referrer: data.referrer ? String(data.referrer).slice(0, 120) : null,
      affiliate_exists: Boolean(data.affiliate_exists),
      ts: data.ts || data.logged_at || new Date().toISOString(),
      logged_at: data.logged_at || new Date().toISOString(),
    };
  }
  if (type === "conversion") {
    return {
      id: data.id || id,
      ref: data.ref || "",
      affiliate_email: data.affiliate_email || "",
      affiliate_name: data.affiliate_name || "",
      user_email: data.user_email || "",
      action: data.action || "signup",
      status: data.status || "pending",
      commission_pct: data.commission_pct || 40,
      created_at: data.created_at || new Date().toISOString(),
      updated_at: data.updated_at || new Date().toISOString(),
    };
  }
  return {
    id: data.id || id,
    name: String(data.name || "").slice(0, 120),
    email: String(data.email || "").slice(0, 200),
    uid: data.uid || null,
    website: String(data.website || "").slice(0, 160),
    audience: String(data.audience || "").slice(0, 240),
    paypal_email: String(data.paypal_email || "").slice(0, 160),
    promote: String(data.promote || "").slice(0, 240),
    referral_slug: String(data.referral_slug || "").slice(0, 80),
    referral_link: String(data.referral_link || "").slice(0, 160),
    status: data.status || "active",
    created_at: data.created_at || new Date().toISOString(),
    updated_at: data.updated_at || new Date().toISOString(),
  };
}

async function upsertAuthRecord(uid, claims) {
  // Intentionally unused for writes: Auth must only contain real human accounts.
  // Kept as a read-side helper name historical callers may expect.
  void uid;
  void claims;
  throw storageError();
}

/**
 * Pull affiliate/tracking/conversion stubs that were wrongly stored as Auth users
 * into a store object (does not write Auth).
 */
async function importAuthStoreRecordsInto(store) {
  const adminAuth = auth();
  let pageToken;
  let imported = 0;
  do {
    const page = await adminAuth.listUsers(1000, pageToken);
    for (const user of page.users) {
      if (user.email) continue;
      const claims = user.customClaims || {};
      if (claims.sc_store_type === "affiliate" && claims.sc_store_data?.id) {
        const id = claims.sc_store_data.id;
        if (!store.affiliates[id]) {
          store.affiliates[id] = compactRecord("affiliate", id, claims.sc_store_data);
          imported += 1;
        }
      } else if (claims.sc_store_type === "tracking" && claims.sc_store_data?.id) {
        const id = claims.sc_store_data.id;
        if (!store.affiliate_tracking[id]) {
          store.affiliate_tracking[id] = compactRecord("tracking", id, claims.sc_store_data);
          imported += 1;
        }
      } else if (claims.sc_store_type === "conversion" && claims.sc_store_data?.id) {
        const id = claims.sc_store_data.id;
        if (!store.affiliate_conversions[id]) {
          store.affiliate_conversions[id] = compactRecord("conversion", id, claims.sc_store_data);
          imported += 1;
        }
      }
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return imported;
}

async function loadStoreFromAuth() {
  const store = emptyStore();
  await importAuthStoreRecordsInto(store);
  return normalizeStore(store);
}

async function saveStoreToAuth() {
  // Never store application data as fake Auth users.
  throw storageError();
}

// ---------------------------------------------------------------------------
// Public API  (same interface as the old Blob-based store)
// ---------------------------------------------------------------------------

async function loadStoreRemote() {
  if (gistConfigured()) {
    useGistStore = true;
    return normalizeStore(await loadGistStore());
  }

  if (firestoreUnavailable) {
    return loadStoreFromAuth();
  }

  try {
    const snap = await db().doc("config/store").get();
    if (snap.exists) return normalizeStore(snap.data());
  } catch (err) {
    console.warn("store: Firestore read failed:", err.message);
    if (isFirestoreUnavailable(err)) {
      firestoreUnavailable = true;
      return loadStoreFromAuth();
    }
    throw storageError();
  }
  return emptyStore();
}

/**
 * @param {{ forceRemote?: boolean }} [opts]
 */
async function loadStore(opts = {}) {
  const { forceRemote = false } = opts;

  if (!forceRemote && writeCache) {
    return cloneStore(writeCache);
  }

  const remote = await loadStoreRemote();

  if (!writeCache || (remote._version || 0) >= (writeCache._version || 0)) {
    writeCache = cloneStore(remote);
  }

  return cloneStore(writeCache);
}

function invalidateCache() {
  writeCache = null;
}

async function saveStore(data) {
  const normalized = normalizeStore(data);
  normalized._updated_at = new Date().toISOString();

  // Update in-memory cache immediately so the current lambda sees its writes.
  writeCache = cloneStore(normalized);

  if (useGistStore || (firestoreUnavailable && gistConfigured())) {
    useGistStore = true;
    await saveGistStore(normalized);
    return normalized;
  }

  if (firestoreUnavailable) {
    throw storageError();
  }

  try {
    await db().doc("config/store").set(normalized);
  } catch (err) {
    console.warn("store: Firestore write failed:", err.message);
    if (isFirestoreUnavailable(err)) {
      firestoreUnavailable = true;
      if (gistConfigured()) {
        useGistStore = true;
        await saveGistStore(normalized);
        return normalized;
      }
    }
    throw storageError();
  }

  return normalized;
}

/**
 * Atomic read-modify-write via Firestore transaction.
 *
 * @param {(store: object) => any} mutator — async function that mutates the
 *   store in-place and returns a value (e.g. the created key record).
 * @returns {Promise<any>} whatever `mutator` returns.
 */
async function mutateStore(mutator) {
  if (gistConfigured() || useGistStore || firestoreUnavailable) {
    if (gistConfigured()) useGistStore = true;

    for (let attempt = 0; attempt < 5; attempt++) {
      const store = await loadStore({ forceRemote: true });
      const baseVersion = store._version || 0;
      const result = await mutator(store);
      store._version = baseVersion + 1;
      store._updated_at = new Date().toISOString();

      const latest = await loadStoreRemote();
      if ((latest._version || 0) > baseVersion) {
        invalidateCache();
        await new Promise((r) => setTimeout(r, 80 + attempt * 60));
        continue;
      }

      await saveStore(store);
      return result;
    }
    const err = new Error("Store write conflict — please retry");
    err.status = 409;
    throw err;
  }

  const docRef = db().doc("config/store");

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await db().runTransaction(async (tx) => {
        const snap = await tx.get(docRef);
        const store = snap.exists ? normalizeStore(snap.data()) : emptyStore();

        // Let the caller mutate the store snapshot
        const result = await mutator(store);

        // Bump version and timestamp
        store._version = (store._version || 0) + 1;
        store._updated_at = new Date().toISOString();

        tx.set(docRef, store);

        // Update in-memory cache
        writeCache = cloneStore(store);

        return result;
      });
    } catch (err) {
      // Firestore throws code 10 (ABORTED) when a transaction conflicts.
      // Retry with exponential backoff.
      if (attempt < 4 && err.code === 10) {
        invalidateCache();
        await new Promise((r) => setTimeout(r, 80 + attempt * 60));
        continue;
      }
      if (isFirestoreUnavailable(err)) {
        console.warn("store: Firestore transaction unavailable:", err.message);
        firestoreUnavailable = true;
        throw storageError();
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Query helpers  (unchanged)
// ---------------------------------------------------------------------------

function listUserKeys(store, userId) {
  return Object.values(store.keys)
    .filter((k) => k.user_id === userId && !k.revoked)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function userUsage(store, userId) {
  const out = {};
  for (const k of listUserKeys(store, userId)) {
    out[k.id] = snapshotForKey(store, k.id);
  }
  return out;
}

function snapshotForKey(store, keyId) {
  const snap = {
    total_requests: 0,
    total_tokens_in: 0,
    total_tokens_out: 0,
    total_tokens_saved: 0,
    by_day: {},
  };
  const days = store.usage[keyId] || {};
  for (const [day, rec] of Object.entries(days)) {
    snap.by_day[day] = rec;
    snap.total_requests += rec.requests || 0;
    snap.total_tokens_in += rec.tokens_in || 0;
    snap.total_tokens_out += rec.tokens_out || 0;
    snap.total_tokens_saved += rec.tokens_saved || 0;
  }
  return snap;
}

function publicKey(rec) {
  return {
    id: rec.id,
    name: rec.name,
    prefix: rec.prefix,
    created_at: rec.created_at,
    last_used_at: rec.last_used_at,
    revoked: rec.revoked,
  };
}

/**
 * Persist per-coding-agent usage in a dedicated Firestore doc so it cannot be
 * lost when the monolithic config/store document conflicts or overflows.
 * Falls back to embedding into config/store when Firestore is unavailable.
 */
async function trackCodingAgentUsage(ownerUid, codingAgent, stats = {}) {
  if (!ownerUid || !codingAgent) return false;
  const agentName = String(codingAgent).toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 64);
  if (!agentName) return false;
  const tokensIn = Math.max(0, Number(stats.original_tokens) || 0);
  const tokensOut = Math.max(0, Number(stats.kept_tokens) || 0);
  const tokensSaved = Math.max(0, Number(stats.tokens_saved) || Math.max(0, tokensIn - tokensOut));
  const now = new Date().toISOString();

  if (firestoreUnavailable) {
    await mutateStore((store) => {
      if (!store.coding_agent_usage) store.coding_agent_usage = {};
      if (!store.coding_agent_usage[ownerUid]) store.coding_agent_usage[ownerUid] = {};
      if (!store.coding_agent_usage[ownerUid][agentName]) {
        store.coding_agent_usage[ownerUid][agentName] = {
          requests: 0,
          tokens_in: 0,
          tokens_out: 0,
          tokens_saved: 0,
          first_seen: now,
          last_seen: now,
        };
      }
      const agent = store.coding_agent_usage[ownerUid][agentName];
      agent.requests += 1;
      agent.tokens_in += tokensIn;
      agent.tokens_out += tokensOut;
      agent.tokens_saved += tokensSaved;
      agent.last_seen = now;
      return true;
    });
    return true;
  }

  const docRef = db().collection("coding_agent_usage").doc(ownerUid);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const data = snap.exists && snap.data() ? snap.data() : { agents: {} };
    const agents = data.agents && typeof data.agents === "object" ? data.agents : {};
    const prev = agents[agentName] || {
      requests: 0,
      tokens_in: 0,
      tokens_out: 0,
      tokens_saved: 0,
      first_seen: now,
      last_seen: now,
    };
    agents[agentName] = {
      requests: (prev.requests || 0) + 1,
      tokens_in: (prev.tokens_in || 0) + tokensIn,
      tokens_out: (prev.tokens_out || 0) + tokensOut,
      tokens_saved: (prev.tokens_saved || 0) + tokensSaved,
      first_seen: prev.first_seen || now,
      last_seen: now,
    };
    tx.set(docRef, { agents, updated_at: now }, { merge: true });
  });
  return true;
}

async function loadCodingAgentUsage(ownerUid) {
  if (!ownerUid) return {};
  if (!firestoreUnavailable) {
    try {
      const snap = await db().collection("coding_agent_usage").doc(ownerUid).get();
      if (snap.exists) {
        const agents = snap.data()?.agents;
        if (agents && typeof agents === "object") return agents;
      }
    } catch (err) {
      console.warn("store: coding_agent_usage read failed:", err.message);
      if (isFirestoreUnavailable(err)) firestoreUnavailable = true;
    }
  }
  const store = await loadStore({ forceRemote: true });
  return store.coding_agent_usage?.[ownerUid] || {};
}

module.exports = {
  loadStore,
  saveStore,
  mutateStore,
  invalidateCache,
  listUserKeys,
  userUsage,
  snapshotForKey,
  publicKey,
  trackCodingAgentUsage,
  loadCodingAgentUsage,
  importAuthStoreRecordsInto,
  recordUid,
};
