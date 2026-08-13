/**
 * Durable rate limiter (Firestore) with in-memory fallback.
 *
 * Why: Vercel serverless is multi-instance. The Map in http.js resets on every
 * cold start, so scrapers / demo abusers can burn through invocation quotas.
 * Firestore gives a shared counter across instances.
 *
 * For authenticated paid endpoints, callers should treat backend !== "firestore"
 * as fail-closed (reject) so multi-instance fans-out cannot bypass the ceiling.
 *
 * Optional requestId makes increments idempotent for *true* retries.
 * Pass SHA256(idempotencyKey + ":" + payloadFingerprint) so a reused
 * idempotency key with a different body still consumes a new slot.
 */
const crypto = require("crypto");
const admin = require("firebase-admin");
const { initFirebaseAdmin } = require("./auth");
const { skipFirestore } = require("./firebase-off");

const memoryBuckets = new Map();

function bucketId(key, windowMs) {
  const bucket = Math.floor(Date.now() / windowMs);
  return crypto
    .createHash("sha256")
    .update(`${key}|${windowMs}|${bucket}`)
    .digest("hex")
    .slice(0, 40);
}

function db() {
  if (!initFirebaseAdmin()) return null;
  try {
    return admin.firestore();
  } catch {
    return null;
  }
}

function sanitizeHitId(raw) {
  const s = String(raw || "").trim();
  if (!s || s.length < 8 || s.length > 128) return null;
  if (!/^[\w.:-]+$/.test(s)) return null;
  return s;
}

function memoryRateLimit(key, maxRequests, windowMs) {
  const id = bucketId(key, windowMs);
  const resetMs = Math.ceil(Date.now() / windowMs) * windowMs;
  const prev = memoryBuckets.get(id) || { count: 0, resetMs };
  const count = prev.resetMs === resetMs ? prev.count + 1 : 1;
  memoryBuckets.set(id, { count, resetMs });
  if (memoryBuckets.size > 4000) {
    const now = Date.now();
    for (const [k, v] of memoryBuckets) {
      if (v.resetMs < now) memoryBuckets.delete(k);
    }
  }
  return {
    allowed: count <= maxRequests,
    remaining: Math.max(0, maxRequests - count),
    resetMs,
    limit: maxRequests,
    backend: "memory",
  };
}

/**
 * @param {string} key
 * @param {number} maxRequests
 * @param {number} [windowMs=60000]
 * @param {{ requestId?: string }} [opts]
 * @returns {Promise<{ allowed: boolean, remaining: number, resetMs: number, limit: number, backend: string }>}
 */
async function checkDurableRateLimit(key, maxRequests, windowMs = 60_000, opts = {}) {
  const resetMs = Math.ceil(Date.now() / windowMs) * windowMs;
  if (skipFirestore()) {
    return memoryRateLimit(key, maxRequests, windowMs);
  }
  const firestore = db();
  if (!firestore) {
    return memoryRateLimit(key, maxRequests, windowMs);
  }

  const id = bucketId(key, windowMs);
  const ref = firestore.collection("rate_limits").doc(id);
  const hitId = sanitizeHitId(opts.requestId);
  const hitRef = hitId
    ? firestore.collection("rate_limit_hits").doc(`${id}:${hitId}`)
    : null;
  // Never let a stuck Firestore txn burn the whole serverless budget (→ 504).
  const FS_TIMEOUT_MS = 1500;

  try {
    const count = await Promise.race([
      firestore.runTransaction(async (tx) => {
        const hitSnap = hitRef ? await tx.get(hitRef) : null;
        const snap = await tx.get(ref);
        const prev = snap.exists ? Number(snap.data().count || 0) : 0;

        if (hitSnap?.exists) {
          const stored = Number(hitSnap.data().count || prev);
          return stored;
        }

        const next = prev + 1;
        tx.set(
          ref,
          {
            count: next,
            key: String(key).slice(0, 120),
            windowMs,
            resetMs,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        if (hitRef) {
          tx.set(
            hitRef,
            {
              count: next,
              key: String(key).slice(0, 120),
              request_id: hitId,
              created_at: new Date().toISOString(),
              expires_at: resetMs,
            },
            { merge: false }
          );
        }
        return next;
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("durable rate limit timeout")), FS_TIMEOUT_MS);
      }),
    ]);

    return {
      allowed: count <= maxRequests,
      remaining: Math.max(0, maxRequests - count),
      resetMs,
      limit: maxRequests,
      backend: "firestore",
    };
  } catch (err) {
    console.warn("durable rate limit unavailable", err?.message || err);
    return memoryRateLimit(key, maxRequests, windowMs);
  }
}

/**
 * Enforce several windows; first failure wins.
 * @param {Array<{ key: string, max: number, windowMs: number, requestId?: string }>} rules
 * @param {{ requestId?: string }} [opts]
 */
async function enforceRateLimits(rules, opts = {}) {
  let last = null;
  for (const rule of rules) {
    last = await checkDurableRateLimit(rule.key, rule.max, rule.windowMs, {
      requestId: rule.requestId || opts.requestId,
    });
    if (!last.allowed) return last;
  }
  return last || { allowed: true, remaining: 0, resetMs: Date.now(), limit: 0, backend: "none" };
}

module.exports = {
  checkDurableRateLimit,
  enforceRateLimits,
};
