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
const { gistConfigured, loadGistStore, saveGistStore } = require("./gist-store");

let /** @type {import("firebase-admin").firestore.Firestore | null} */ _db = null;

/** In-process write-through cache — same warm lambda sees updates immediately. */
let writeCache = null;
let firestoreUnavailable = false;
let useGistStore = false;

/** Gist is the real prod store while Firestore API is disabled on this project.
 * Set SUPERCOMPRESS_DISABLE_GIST=1 to force Firestore-only (fails closed). */
function gistAllowed() {
  if (String(process.env.SUPERCOMPRESS_DISABLE_GIST || "").trim() === "1") {
    return false;
  }
  return gistConfigured();
}

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
    agent_links: {},
    welcome_emails: {},
    weekly_emails: {},
    weekly_unsubscribes: {},
    compress_logs: {},
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
    agent_links: raw.agent_links && typeof raw.agent_links === "object" ? raw.agent_links : {},
    welcome_emails: raw.welcome_emails && typeof raw.welcome_emails === "object" ? raw.welcome_emails : {},
    weekly_emails: raw.weekly_emails && typeof raw.weekly_emails === "object" ? raw.weekly_emails : {},
    weekly_unsubscribes: raw.weekly_unsubscribes && typeof raw.weekly_unsubscribes === "object" ? raw.weekly_unsubscribes : {},
    compress_logs: raw.compress_logs && typeof raw.compress_logs === "object" ? raw.compress_logs : {},
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

// ---------------------------------------------------------------------------
// Public API  (same interface as the old Blob-based store)
// ---------------------------------------------------------------------------

async function loadStoreRemote() {
  // Prefer Firestore whenever Admin credentials exist. Gist is emergency-only —
  // using it for every write burns GitHub rate limits and breaks connect/setup.
  if (!firestoreUnavailable) {
    try {
      const snap = await db().doc("config/store").get();
      if (snap.exists) {
        useGistStore = false;
        return normalizeStore(snap.data());
      }

      // Empty Firestore: one-time seed from gist only when explicitly allowed.
      if (gistAllowed()) {
        try {
          const fromGist = normalizeStore(await loadGistStore());
          const hasData =
            Object.keys(fromGist.keys || {}).length > 0 ||
            Object.keys(fromGist.connections || {}).length > 0 ||
            Object.keys(fromGist.affiliates || {}).length > 0;
          if (hasData) {
            await db().doc("config/store").set(fromGist);
            console.warn("store: seeded Firestore from gist backup");
            useGistStore = false;
            return fromGist;
          }
        } catch (gistErr) {
          console.warn("store: gist seed skipped:", gistErr.message);
        }
      }

      useGistStore = false;
      return emptyStore();
    } catch (err) {
      console.warn("store: Firestore read failed:", err.message);
      if (isFirestoreUnavailable(err)) {
        firestoreUnavailable = true;
      } else {
        throw err.status ? err : storageError();
      }
    }
  }

  if (gistAllowed()) {
    useGistStore = true;
    return normalizeStore(await loadGistStore());
  }

  return loadStoreFromAuth();
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

  if (!firestoreUnavailable && !useGistStore) {
    try {
      await db().doc("config/store").set(normalized);
      return normalized;
    } catch (err) {
      console.warn("store: Firestore write failed:", err.message);
      if (isFirestoreUnavailable(err)) {
        firestoreUnavailable = true;
      } else {
        throw storageError();
      }
    }
  }

  if (gistAllowed()) {
    useGistStore = true;
    await saveGistStore(normalized);
    return normalized;
  }

  throw storageError();
}

/**
 * Atomic read-modify-write via Firestore transaction.
 *
 * @param {(store: object) => any} mutator — async function that mutates the
 *   store in-place and returns a value (e.g. the created key record).
 * @returns {Promise<any>} whatever `mutator` returns.
 */
async function mutateStore(mutator) {
  // Reset sticky gist flag when gist is disabled — warm lambdas may still have it set.
  if (!gistAllowed()) {
    useGistStore = false;
  }

  // Gist path only when explicitly allowed AND Firestore is known-down.
  if (gistAllowed() && (useGistStore || firestoreUnavailable)) {
    useGistStore = true;

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
        if (gistAllowed()) {
          useGistStore = true;
          return mutateStore(mutator);
        }
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

function emptyKeySnap() {
  return {
    total_requests: 0,
    total_tokens_in: 0,
    total_tokens_out: 0,
    total_tokens_saved: 0,
    by_day: {},
  };
}

function mergeKeySnaps(a = {}, b = {}) {
  const out = emptyKeySnap();
  const days = new Set([
    ...Object.keys(a.by_day || {}),
    ...Object.keys(b.by_day || {}),
  ]);
  for (const day of days) {
    const left = (a.by_day && a.by_day[day]) || {};
    const right = (b.by_day && b.by_day[day]) || {};
    const rec = {
      key_id: left.key_id || right.key_id || null,
      requests: (left.requests || 0) + (right.requests || 0),
      tokens_in: (left.tokens_in || 0) + (right.tokens_in || 0),
      tokens_out: (left.tokens_out || 0) + (right.tokens_out || 0),
      tokens_saved: (left.tokens_saved || 0) + (right.tokens_saved || 0),
    };
    out.by_day[day] = rec;
    out.total_requests += rec.requests;
    out.total_tokens_in += rec.tokens_in;
    out.total_tokens_out += rec.tokens_out;
    out.total_tokens_saved += rec.tokens_saved;
  }
  // If either side only has totals (no by_day), fold them in once.
  if (!days.size) {
    out.total_requests = (a.total_requests || 0) + (b.total_requests || 0);
    out.total_tokens_in = (a.total_tokens_in || 0) + (b.total_tokens_in || 0);
    out.total_tokens_out = (a.total_tokens_out || 0) + (b.total_tokens_out || 0);
    out.total_tokens_saved = (a.total_tokens_saved || 0) + (b.total_tokens_saved || 0);
  }
  return out;
}

/**
 * Durable per-key usage — dedicated Firestore doc (same pattern as coding_agent_usage).
 * The monolithic config/store was dropping key meters while Auth sc_usage (billing) kept growing.
 */
async function trackKeyUsage(ownerUid, keyRec, stats = {}) {
  if (!ownerUid || !keyRec) return false;
  const keyId = String(keyRec.id || keyRec.uid || "").trim();
  if (!keyId) return false;
  const day = String(stats.day || new Date().toISOString().slice(0, 10));
  const tokensIn = Math.max(0, Number(stats.original_tokens) || 0);
  const tokensOut = Math.max(0, Number(stats.kept_tokens) || 0);
  const tokensSaved = Math.max(
    0,
    Number(stats.tokens_saved) || Math.max(0, tokensIn - tokensOut)
  );
  const now = new Date().toISOString();

  const bump = (prev = {}) => {
    const byDay = { ...(prev.by_day || {}) };
    const dayRec = byDay[day] || {
      key_id: keyId,
      requests: 0,
      tokens_in: 0,
      tokens_out: 0,
      tokens_saved: 0,
    };
    dayRec.requests += 1;
    dayRec.tokens_in += tokensIn;
    dayRec.tokens_out += tokensOut;
    dayRec.tokens_saved += tokensSaved;
    byDay[day] = dayRec;
    return {
      key_id: keyId,
      name: keyRec.name || prev.name || null,
      prefix: keyRec.prefix || prev.prefix || null,
      requests: (prev.requests || 0) + 1,
      tokens_in: (prev.tokens_in || 0) + tokensIn,
      tokens_out: (prev.tokens_out || 0) + tokensOut,
      tokens_saved: (prev.tokens_saved || 0) + tokensSaved,
      first_seen: prev.first_seen || now,
      last_seen: now,
      by_day: byDay,
    };
  };

  if (firestoreUnavailable) {
    await mutateStore((store) => {
      if (!store.keys[keyId]) {
        store.keys[keyId] = {
          id: keyId,
          user_id: ownerUid,
          name: keyRec.name || "API key",
          prefix: keyRec.prefix || "",
          key_hash: keyRec.key_hash || null,
          created_at: keyRec.created_at || now,
          last_used_at: now,
          revoked: false,
        };
        if (keyRec.key_hash) store.hash_index[keyRec.key_hash] = keyId;
      } else {
        store.keys[keyId].last_used_at = now;
      }
      if (!store.usage[keyId]) store.usage[keyId] = {};
      if (!store.usage[keyId][day]) {
        store.usage[keyId][day] = {
          key_id: keyId,
          requests: 0,
          tokens_in: 0,
          tokens_out: 0,
          tokens_saved: 0,
        };
      }
      const u = store.usage[keyId][day];
      u.requests += 1;
      u.tokens_in += tokensIn;
      u.tokens_out += tokensOut;
      u.tokens_saved += tokensSaved;
      return u;
    });
    return true;
  }

  const docRef = db().collection("key_usage").doc(ownerUid);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const data = snap.exists && snap.data() ? snap.data() : { keys: {} };
    const keys = data.keys && typeof data.keys === "object" ? data.keys : {};
    keys[keyId] = bump(keys[keyId]);
    tx.set(docRef, { keys, updated_at: now }, { merge: true });
  });
  return true;
}

async function loadKeyUsage(ownerUid) {
  if (!ownerUid) return {};
  const out = {};
  if (!firestoreUnavailable) {
    try {
      const snap = await db().collection("key_usage").doc(ownerUid).get();
      if (snap.exists) {
        const keys = snap.data()?.keys;
        if (keys && typeof keys === "object") {
          for (const [id, rec] of Object.entries(keys)) {
            if (!rec || typeof rec !== "object") continue;
            out[id] = {
              total_requests: rec.requests || 0,
              total_tokens_in: rec.tokens_in || 0,
              total_tokens_out: rec.tokens_out || 0,
              total_tokens_saved: rec.tokens_saved || 0,
              by_day: rec.by_day || {},
            };
          }
        }
      }
    } catch (err) {
      console.warn("store: key_usage read failed:", err.message);
      if (isFirestoreUnavailable(err)) firestoreUnavailable = true;
    }
  }
  return out;
}

/**
 * If Auth billing meter is ahead of durable key meters, attribute the gap to the
 * owner's primary key so the dashboard never shows "per-key store empty" while
 * billing has millions of tokens. Persists once into key_usage.
 */
async function reconcileKeyUsageGap(ownerUid, keys, usageMap, accountUsage) {
  if (!ownerUid || !accountUsage || !keys?.length) return usageMap;
  const acctIn = accountUsage.tokens_in || 0;
  if (acctIn <= 0) return usageMap;

  let sumIn = 0;
  let sumOut = 0;
  let sumSaved = 0;
  let sumReqs = 0;
  for (const snap of Object.values(usageMap || {})) {
    sumIn += snap.total_tokens_in || 0;
    sumOut += snap.total_tokens_out || 0;
    sumSaved += snap.total_tokens_saved || 0;
    sumReqs += snap.total_requests || 0;
  }

  const gapIn = acctIn - sumIn;
  if (gapIn < 500) return usageMap; // close enough

  const ranked = [...keys].sort((a, b) => {
    const aT = a.last_used_at ? Date.parse(a.last_used_at) : 0;
    const bT = b.last_used_at ? Date.parse(b.last_used_at) : 0;
    if (bT !== aT) return bT - aT;
    // Prefer coding-agent / default names
    const score = (k) =>
      /coding agent|default|production/i.test(k.name || "") ? 1 : 0;
    return score(b) - score(a);
  });
  const target = ranked[0];
  if (!target?.id) return usageMap;

  const gapReqs = Math.max(0, (accountUsage.requests || 0) - sumReqs);
  const gapOut = Math.max(0, (accountUsage.tokens_out || 0) - sumOut);
  const gapSaved = Math.max(0, (accountUsage.tokens_saved || 0) - sumSaved);
  // ISO day so analytics charts can plot the gap. Once-per-month via reconciled flag.
  const day = new Date().toISOString().slice(0, 10);
  const month = String(accountUsage.month || day.slice(0, 7));

  const next = { ...(usageMap || {}) };
  const prev = next[target.id] || emptyKeySnap();
  const byDay = { ...(prev.by_day || {}) };
  const alreadyReconciled = Object.entries(byDay).some(([k, v]) => {
    if (!v || !v.reconciled) return false;
    if (k === `reconcile-${month}`) return true;
    return String(k).startsWith(`${month}-`);
  });
  if (alreadyReconciled) return usageMap;

  byDay[day] = {
    key_id: target.id,
    requests: (byDay[day]?.requests || 0) + gapReqs,
    tokens_in: (byDay[day]?.tokens_in || 0) + gapIn,
    tokens_out: (byDay[day]?.tokens_out || 0) + gapOut,
    tokens_saved: (byDay[day]?.tokens_saved || 0) + gapSaved,
    reconciled: true,
  };
  next[target.id] = {
    total_requests: (prev.total_requests || 0) + gapReqs,
    total_tokens_in: (prev.total_tokens_in || 0) + gapIn,
    total_tokens_out: (prev.total_tokens_out || 0) + gapOut,
    total_tokens_saved: (prev.total_tokens_saved || 0) + gapSaved,
    by_day: byDay,
  };

  // Persist reconciled bucket so refresh stays stable.
  if (!firestoreUnavailable) {
    try {
      const now = new Date().toISOString();
      const docRef = db().collection("key_usage").doc(ownerUid);
      await db().runTransaction(async (tx) => {
        const snap = await tx.get(docRef);
        const data = snap.exists && snap.data() ? snap.data() : { keys: {} };
        const keysMap = data.keys && typeof data.keys === "object" ? { ...data.keys } : {};
        const prevRec = keysMap[target.id] || {};
        const prevDays = { ...(prevRec.by_day || {}) };
        const txAlready = Object.entries(prevDays).some(([k, v]) => {
          if (!v || !v.reconciled) return false;
          if (k === `reconcile-${month}`) return true;
          return String(k).startsWith(`${month}-`);
        });
        if (txAlready) {
          return;
        }
        prevDays[day] = {
          key_id: target.id,
          requests: gapReqs,
          tokens_in: gapIn,
          tokens_out: gapOut,
          tokens_saved: gapSaved,
          reconciled: true,
        };
        keysMap[target.id] = {
          key_id: target.id,
          name: target.name || prevRec.name || null,
          prefix: target.prefix || prevRec.prefix || null,
          requests: (prevRec.requests || 0) + gapReqs,
          tokens_in: (prevRec.tokens_in || 0) + gapIn,
          tokens_out: (prevRec.tokens_out || 0) + gapOut,
          tokens_saved: (prevRec.tokens_saved || 0) + gapSaved,
          first_seen: prevRec.first_seen || now,
          last_seen: now,
          by_day: prevDays,
        };
        tx.set(
          docRef,
          { keys: keysMap, updated_at: now, reconciled_at: now },
          { merge: true }
        );
      });
    } catch (err) {
      console.warn("store: key_usage reconcile failed:", err.message);
    }
  }

  return next;
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
  const latencyMs =
    stats.latency_ms != null && Number.isFinite(Number(stats.latency_ms))
      ? Math.max(0, Math.round(Number(stats.latency_ms)))
      : null;
  const cutPct = tokensIn > 0 ? Math.round((tokensSaved / tokensIn) * 10000) / 100 : 0;
  const lastQuery = String(stats.query || "").trim().slice(0, 160);
  const source = stats.source
    ? String(stats.source).toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 32)
    : null;
  const now = new Date().toISOString();

  const bump = (prev) => {
    const next = {
      requests: (prev.requests || 0) + 1,
      tokens_in: (prev.tokens_in || 0) + tokensIn,
      tokens_out: (prev.tokens_out || 0) + tokensOut,
      tokens_saved: (prev.tokens_saved || 0) + tokensSaved,
      first_seen: prev.first_seen || now,
      last_seen: now,
      last_pct: cutPct,
      last_query: lastQuery || prev.last_query || null,
      last_source: source || prev.last_source || null,
      latency_sum_ms: prev.latency_sum_ms || 0,
      latency_samples: prev.latency_samples || 0,
      last_latency_ms: prev.last_latency_ms || null,
      avg_latency_ms: prev.avg_latency_ms || null,
    };
    if (latencyMs != null) {
      next.latency_sum_ms = (prev.latency_sum_ms || 0) + latencyMs;
      next.latency_samples = (prev.latency_samples || 0) + 1;
      next.last_latency_ms = latencyMs;
      next.avg_latency_ms = Math.round(next.latency_sum_ms / next.latency_samples);
    }
    return next;
  };

  if (firestoreUnavailable) {
    await mutateStore((store) => {
      if (!store.coding_agent_usage) store.coding_agent_usage = {};
      if (!store.coding_agent_usage[ownerUid]) store.coding_agent_usage[ownerUid] = {};
      const prev = store.coding_agent_usage[ownerUid][agentName] || {
        requests: 0,
        tokens_in: 0,
        tokens_out: 0,
        tokens_saved: 0,
        first_seen: now,
        last_seen: now,
      };
      store.coding_agent_usage[ownerUid][agentName] = bump(prev);
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
    agents[agentName] = bump(prev);
    tx.set(docRef, { agents, updated_at: now }, { merge: true });
  });
  return true;
}

/**
 * Cursor postToolUse used to default coding_agent to "Claude Code" whenever the
 * hook payload had session_id/cwd (Cursor always does). Those rows look like
 * claude_code + last_source tool_shell|tool_read|… Merge them into cursor.
 */
function repairMisattributedCodingAgents(agents) {
  if (!agents || typeof agents !== "object") return { agents: {}, changed: false };
  const next = { ...agents };
  const bad = next.claude_code || next["claude-code"];
  if (!bad || typeof bad !== "object") return { agents: next, changed: false };

  const src = String(bad.last_source || "").toLowerCase();
  const q = String(bad.last_query || "");
  const looksLikeCursorTool =
    /^tool_(shell|read|grep|task|awaitshell|await|webfetch|websearch|edit|write|glob|mcp)/i.test(
      src
    ) || /^Compress new .+ output for the current coding task/i.test(q);

  if (!looksLikeCursorTool) return { agents: next, changed: false };

  const cursor = next.cursor && typeof next.cursor === "object" ? next.cursor : null;
  const merged = {
    requests: (cursor?.requests || 0) + (bad.requests || 0),
    tokens_in: (cursor?.tokens_in || 0) + (bad.tokens_in || 0),
    tokens_out: (cursor?.tokens_out || 0) + (bad.tokens_out || 0),
    tokens_saved: (cursor?.tokens_saved || 0) + (bad.tokens_saved || 0),
    first_seen: [cursor?.first_seen, bad.first_seen].filter(Boolean).sort()[0] || bad.first_seen || null,
    last_seen: [cursor?.last_seen, bad.last_seen].filter(Boolean).sort().slice(-1)[0] || bad.last_seen || null,
    last_pct: bad.last_pct != null ? bad.last_pct : cursor?.last_pct ?? null,
    last_query: bad.last_query || cursor?.last_query || null,
    last_source: bad.last_source || cursor?.last_source || null,
    latency_sum_ms: (cursor?.latency_sum_ms || 0) + (bad.latency_sum_ms || 0),
    latency_samples: (cursor?.latency_samples || 0) + (bad.latency_samples || 0),
    last_latency_ms: bad.last_latency_ms != null ? bad.last_latency_ms : cursor?.last_latency_ms ?? null,
  };
  if (merged.latency_samples > 0) {
    merged.avg_latency_ms = Math.round(merged.latency_sum_ms / merged.latency_samples);
  } else if (cursor?.avg_latency_ms != null || bad.avg_latency_ms != null) {
    merged.avg_latency_ms = bad.avg_latency_ms != null ? bad.avg_latency_ms : cursor.avg_latency_ms;
  }
  next.cursor = merged;
  delete next.claude_code;
  delete next["claude-code"];
  return { agents: next, changed: true };
}

async function loadCodingAgentUsage(ownerUid) {
  if (!ownerUid) return {};
  if (!firestoreUnavailable) {
    try {
      const docRef = db().collection("coding_agent_usage").doc(ownerUid);
      const snap = await docRef.get();
      if (snap.exists) {
        const agents = snap.data()?.agents;
        if (agents && typeof agents === "object") {
          const { agents: fixed, changed } = repairMisattributedCodingAgents(agents);
          if (changed) {
            // Persist repair so dashboard stays correct without re-deriving every read.
            const now = new Date().toISOString();
            docRef.set({ agents: fixed, updated_at: now, repaired_claude_to_cursor_at: now }, { merge: true }).catch((err) => {
              console.warn("store: coding_agent_usage repair persist failed:", err.message);
            });
          }
          return fixed;
        }
      }
    } catch (err) {
      console.warn("store: coding_agent_usage read failed:", err.message);
      if (isFirestoreUnavailable(err)) firestoreUnavailable = true;
    }
  }
  const store = await loadStore({ forceRemote: true });
  const embedded = store.coding_agent_usage?.[ownerUid] || {};
  return repairMisattributedCodingAgents(embedded).agents;
}

/**
 * OAuth / device-link status for coding-agent installs.
 * Prefer explicit agent_links[uid]; fall back to any linked connections for this owner
 * so users who already completed browser sign-in show as connected without re-linking.
 */
async function loadAgentPluginLink(ownerUid) {
  if (!ownerUid) return { linked: false };
  const store = await loadStore({ forceRemote: true });
  const explicit = store.agent_links?.[ownerUid];
  if (explicit && explicit.linked) {
    return {
      linked: true,
      linked_at: explicit.linked_at || null,
      source: explicit.source || "oauth",
      agents: Array.isArray(explicit.agents) ? explicit.agents : [],
    };
  }

  const connections = store.connections || {};
  let latest = null;
  for (const rec of Object.values(connections)) {
    if (!rec || rec.owner_uid !== ownerUid || !rec.secret) continue;
    const at = rec.linked_at || rec.created_at || null;
    if (!latest || (at && (!latest.linked_at || at > latest.linked_at))) {
      latest = { linked_at: at, source: rec.source || "oauth" };
    }
  }
  if (latest) {
    return {
      linked: true,
      linked_at: latest.linked_at,
      source: latest.source || "oauth",
      agents: [],
    };
  }
  return { linked: false };
}

async function markAgentPluginLinked(ownerUid, meta = {}) {
  if (!ownerUid) return null;
  const now = new Date().toISOString();
  await mutateStore((store) => {
    if (!store.agent_links) store.agent_links = {};
    const prev = store.agent_links[ownerUid] || {};
    const agents = Array.isArray(meta.agents)
      ? [...new Set([...(prev.agents || []), ...meta.agents])]
      : (prev.agents || []);
    store.agent_links[ownerUid] = {
      linked: true,
      linked_at: prev.linked_at || now,
      updated_at: now,
      source: meta.source || prev.source || "oauth",
      agents,
    };
    return true;
  });
  return loadAgentPluginLink(ownerUid);
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
  trackKeyUsage,
  loadKeyUsage,
  mergeKeySnaps,
  reconcileKeyUsageGap,
  loadAgentPluginLink,
  markAgentPluginLinked,
  importAuthStoreRecordsInto,
};
