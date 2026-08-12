/**
 * POST /api/retrieve  or  GET /api/retrieve?hash=<hash>
 *
 * CCR (Cache, Compress, Retrieve) endpoint.
 * Given a hash from a [SC-Retrieve: hash] marker in compressed output,
 * returns the original uncompressed text block.
 *
 * Requires a valid API key. Blobs are tenant-scoped: only the owning account
 * that stored the hash may retrieve it.
 */

const { json, checkRateLimit, readBody } = require("./_lib/http");
const { bearerToken } = require("./_lib/auth");
const { KEY_PREFIX } = require("./_lib/keys");
const { authenticateKey } = require("./_lib/firebase-key-store");
const { mutateStore } = require("./_lib/store");
const { ccrOwnerDocPath } = require("./_lib/engine");
const { initFirebaseAdmin } = require("./_lib/auth");
const admin = require("firebase-admin");
const CCR_RPM = 600; // generous — retrieval is cheap

function isValidHash(hash) {
  return /^[0-9a-f]{8}_[0-9a-f]+$/.test(hash);
}

/**
 * Load CCR original for this owner only.
 * Legacy flat docs (ccr/{hash}) are readable only when owner_uid matches.
 * Missing/mismatched owner → treat as not found (no cross-tenant oracle).
 */
async function loadOwnedCcr(ownerUid, hash) {
  initFirebaseAdmin();
  const db = admin.firestore();

  const owned = await db.doc(ccrOwnerDocPath(ownerUid, hash)).get();
  if (owned.exists) {
    const data = owned.data() || {};
    if (data.original && (!data.owner_uid || data.owner_uid === ownerUid)) {
      return data.original;
    }
  }

  // Legacy flat path — only if explicitly tagged to this owner
  try {
    const legacy = await db.doc(`ccr/${hash}`).get();
    if (legacy.exists) {
      const data = legacy.data() || {};
      if (data.original && data.owner_uid && data.owner_uid === ownerUid) {
        return data.original;
      }
    }
  } catch (_) {
    /* ignore */
  }

  return null;
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});

  try {
    const raw = req.headers["x-api-key"]
      || bearerToken(req.headers.authorization);
    if (!raw || !raw.startsWith(KEY_PREFIX)) {
      return json(res, 401, { detail: "Missing or invalid API key" });
    }

    const keyPrefix = raw.slice(0, 24);
    const rl = checkRateLimit(`ccr:${keyPrefix}`, CCR_RPM);
    if (!rl.allowed) {
      return json(res, 429, {
        detail: `Rate limit exceeded (${CCR_RPM} requests/minute)`,
        retry_after_seconds: Math.max(1, Math.ceil((rl.resetMs - Date.now()) / 1000)),
      });
    }

    let hash;
    if (req.method === "GET") {
      hash = (req.query && req.query.hash) || "";
    } else if (req.method === "POST") {
      const body = readBody(req);
      hash = body.hash || "";
    } else {
      return json(res, 405, { detail: "Method not allowed", allow: "GET, POST" });
    }

    if (!hash || !isValidHash(hash)) {
      return json(res, 400, { detail: "Invalid hash format. Expected format: 8-hex-chars_hex-length (e.g. 'a1b2c3d4_2f')" });
    }

    const authenticated = await authenticateKey(raw);
    const ownerUid = authenticated.ownerUid;
    const keyId = authenticated.keyId;

    const original = await loadOwnedCcr(ownerUid, hash);
    if (!original) {
      return json(res, 404, {
        detail: "Hash not found. The original content may have been evicted from cache.",
        hash,
      });
    }

    try {
      await mutateStore((store) => {
        const day = new Date().toISOString().slice(0, 10);
        if (!store.usage[keyId]) store.usage[keyId] = {};
        if (!store.usage[keyId][day]) {
          store.usage[keyId][day] = {
            key_id: keyId,
            requests: 0,
            tokens_in: 0,
            tokens_out: 0,
            tokens_saved: 0,
            retrievals: 0,
          };
        }
        const u = store.usage[keyId][day];
        u.retrievals = (u.retrievals || 0) + 1;
      });
    } catch (err) {
      if (err.status !== 503) throw err;
    }

    return json(res, 200, {
      original,
      hash,
      retrieved_at: new Date().toISOString(),
      token_count: original.split(/\s+/).length,
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("retrieve error", err);
    else console.warn("retrieve client error", status, err.message || err);
    return json(res, status, { detail: err.message || String(err) });
  }
};
