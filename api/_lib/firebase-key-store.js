/**
 * API key store — Firestore via config/store (keys + hash_index + usage).
 *
 * Historically keys were stored as fake Firebase Auth users (uid `sck_*`),
 * which polluted the Auth console with "anonymous / no email" rows. New keys
 * never touch Auth. Old Auth-backed keys are migrated into Firestore on use.
 *
 * Owner billing usage (`sc_usage` custom claims) still lives on the real
 * signed-in user account — only that user appears in Auth.
 */

const crypto = require("crypto");
const admin = require("firebase-admin");
const { initFirebaseAdmin } = require("./auth");
const { KEY_PREFIX, hashApiKey, generateApiKey, verifyApiKey } = require("./keys");
const {
  loadStore,
  mutateStore,
  listUserKeys,
  userUsage,
  snapshotForKey,
  publicKey: storePublicKey,
} = require("./store");

const KEY_UID_PREFIX = "sck_";

function auth() {
  if (!initFirebaseAdmin()) {
    const err = new Error("Firebase Admin is not configured");
    err.status = 503;
    throw err;
  }
  return admin.auth();
}

function keyUidFromSecret(secret) {
  if (!secret?.startsWith(KEY_PREFIX)) return null;
  const rest = secret.slice(KEY_PREFIX.length);
  const split = rest.indexOf("_", KEY_UID_PREFIX.length);
  const uid = split > 0 ? rest.slice(0, split) : "";
  return uid.startsWith(KEY_UID_PREFIX) ? uid : null;
}

function publicKey(rec) {
  return storePublicKey(rec);
}

function usageSnapshot(recOrId, store) {
  if (typeof recOrId === "string") {
    return snapshotForKey(store || { usage: {} }, recOrId);
  }
  if (recOrId?.customClaims?.sc_usage) {
    const u = recOrId.customClaims.sc_usage || {};
    return {
      total_requests: u.requests || 0,
      total_tokens_in: u.tokens_in || 0,
      total_tokens_out: u.tokens_out || 0,
      total_tokens_saved: u.tokens_saved || 0,
      by_day: {},
    };
  }
  const id = recOrId?.id;
  if (!id) {
    return {
      total_requests: 0,
      total_tokens_in: 0,
      total_tokens_out: 0,
      total_tokens_saved: 0,
      by_day: {},
    };
  }
  return snapshotForKey(store || { usage: {} }, id);
}

async function ownerRecord(ownerUid) {
  return auth().getUser(ownerUid);
}

/**
 * Import an Auth-backed API key user into Firestore once, then optionally
 * delete the stub Auth user so the console stays email-only.
 */
async function migrateAuthKeyToStore(authUser, secret) {
  const c = authUser.customClaims || {};
  if (!c.sc_api_key || !c.sc_owner || !c.sc_hash) return null;

  const id = authUser.uid;
  const migrated = await mutateStore((store) => {
    if (store.keys[id] && !store.keys[id].revoked) {
      store.hash_index[c.sc_hash] = id;
      return store.keys[id];
    }
    const rec = {
      id,
      user_id: c.sc_owner,
      name: c.sc_name || "Production",
      prefix: c.sc_prefix || (secret ? secret.slice(0, 16) : ""),
      key_hash: c.sc_hash,
      created_at: c.sc_created || authUser.metadata?.creationTime || new Date().toISOString(),
      last_used_at: c.sc_last || null,
      revoked: Boolean(authUser.disabled),
      migrated_from_auth: true,
    };
    store.keys[id] = rec;
    store.hash_index[c.sc_hash] = id;
    if (!store.usage[id]) store.usage[id] = {};
    return rec;
  });

  // Keep Auth stub — coding-agent keys authenticate via Auth first. Deleting the
  // stub left hash_index/store as the only path; when store writes flake, keys
  // vanished from Auth and usage stopped attributing to them.
  return migrated;
}

async function findAuthBackedKey(secret) {
  const uid = keyUidFromSecret(secret);
  if (!uid) return null;
  const user = await auth().getUser(uid).catch(() => null);
  const c = user?.customClaims || {};
  if (!user || user.disabled || !c.sc_api_key || !verifyApiKey(secret, c.sc_hash || "")) {
    return null;
  }
  return user;
}

async function listKeys(ownerUid) {
  const store = await loadStore({ forceRemote: true });

  // One-time pull of any remaining Auth-indexed keys for this owner.
  try {
    const owner = await ownerRecord(ownerUid);
    const ids = Array.isArray(owner.customClaims?.sc_key_ids) ? owner.customClaims.sc_key_ids : [];
    for (const uid of ids) {
      if (store.keys[uid]) continue;
      const user = await auth().getUser(uid).catch(() => null);
      if (user?.customClaims?.sc_api_key) {
        await migrateAuthKeyToStore(user, null);
      }
    }
  } catch (err) {
    console.warn("listKeys: Auth migration skipped:", err.message);
  }

  const fresh = await loadStore({ forceRemote: true });
  const keys = listUserKeys(fresh, ownerUid).map(publicKey);
  let usage = userUsage(fresh, ownerUid);

  // Merge durable key_usage doc (survives monolithic store flakes).
  // Prefer durable when it has data so we never double-count with legacy store.usage.
  try {
    const { loadKeyUsage, mergeKeySnaps, reconcileKeyUsageGap } = require("./store");
    const durable = await loadKeyUsage(ownerUid);
    const hasDurable = Object.values(durable || {}).some((s) => (s.total_tokens_in || 0) > 0);
    if (hasDurable) {
      const merged = {};
      for (const k of keys) {
        merged[k.id] = durable[k.id] || usage[k.id] || mergeKeySnaps({}, {});
      }
      // Include durable rows for keys not currently listed (revoked mid-month etc.)
      for (const [id, snap] of Object.entries(durable)) {
        if (!merged[id]) merged[id] = snap;
      }
      usage = merged;
    } else {
      for (const [id, snap] of Object.entries(durable || {})) {
        usage[id] = mergeKeySnaps(usage[id] || {}, snap);
      }
      for (const k of keys) {
        if (!usage[k.id]) usage[k.id] = mergeKeySnaps({}, {});
      }
    }
  } catch (err) {
    console.warn("listKeys: durable key_usage merge skipped:", err.message);
  }

  let account_usage = null;
  try {
    const owner = await ownerRecord(ownerUid);
    const claims = owner.customClaims || {};
    const month = new Date().toISOString().slice(0, 7);
    const u = claims.sc_usage?.month === month ? claims.sc_usage : null;
    if (u && ((u.tokens_in || 0) > 0 || (u.requests || 0) > 0)) {
      account_usage = {
        month,
        requests: u.requests || 0,
        tokens_in: u.tokens_in || 0,
        tokens_out: u.tokens_out || 0,
        tokens_saved: u.tokens_saved || 0,
      };
    }
  } catch (_) {}

  // Attribute billing-meter gap onto a real key so the table never shows
  // "per-key store empty" when default + coding-agent keys exist.
  if (account_usage && keys.length) {
    try {
      const { reconcileKeyUsageGap } = require("./store");
      usage = await reconcileKeyUsageGap(ownerUid, keys, usage, account_usage);
    } catch (err) {
      console.warn("listKeys: reconcile skipped:", err.message);
    }
  }

  return {
    keys,
    usage,
    account_usage,
  };
}

async function createKey(ownerUid, name, maxKeys) {
  await ownerRecord(ownerUid); // ensure real account exists

  return mutateStore((store) => {
    const active = listUserKeys(store, ownerUid);
    if (active.length >= maxKeys) {
      const err = new Error(`Plan limit reached: ${maxKeys} API keys. Upgrade to increase this limit.`);
      err.status = 429;
      throw err;
    }

    const gen = generateApiKey();
    const id = `key_${crypto.randomBytes(12).toString("hex")}`;
    const created = new Date().toISOString();
    const rec = {
      id,
      user_id: ownerUid,
      name: String(name || "Production").trim().slice(0, 80) || "Production",
      prefix: gen.prefix,
      key_hash: gen.key_hash,
      created_at: created,
      last_used_at: null,
      revoked: false,
    };
    store.keys[id] = rec;
    store.hash_index[gen.key_hash] = id;
    store.usage[id] = {};
    return { key: publicKey(rec), secret: gen.full_key };
  });
}

async function getOwnedKey(ownerUid, keyUid) {
  const store = await loadStore({ forceRemote: true });
  let rec = store.keys[keyUid];

  if (!rec) {
    const user = await auth().getUser(keyUid).catch(() => null);
    if (user?.customClaims?.sc_owner === ownerUid && user.customClaims?.sc_api_key) {
      rec = await migrateAuthKeyToStore(user, null);
    }
  }

  if (!rec || rec.user_id !== ownerUid || rec.revoked) {
    const err = new Error("Key not found");
    err.status = 404;
    throw err;
  }
  return rec;
}

async function renameKey(ownerUid, keyUid, name) {
  await getOwnedKey(ownerUid, keyUid);
  return mutateStore((store) => {
    const rec = store.keys[keyUid];
    if (!rec || rec.user_id !== ownerUid || rec.revoked) {
      const err = new Error("Key not found");
      err.status = 404;
      throw err;
    }
    rec.name = String(name).trim().slice(0, 80);
    store.keys[keyUid] = rec;
    return publicKey(rec);
  });
}

async function revokeKey(ownerUid, keyUid) {
  const existing = await getOwnedKey(ownerUid, keyUid);
  const revoked = await mutateStore((store) => {
    const rec = store.keys[keyUid];
    if (!rec || rec.user_id !== ownerUid) {
      const err = new Error("Key not found");
      err.status = 404;
      throw err;
    }
    rec.revoked = true;
    store.keys[keyUid] = rec;
    if (rec.key_hash && store.hash_index[rec.key_hash] === keyUid) {
      delete store.hash_index[rec.key_hash];
    }
    return { ...publicKey(rec), revoked: true };
  });

  // Clean legacy Auth stub if it still exists
  if (keyUid.startsWith(KEY_UID_PREFIX)) {
    try {
      await auth().deleteUser(keyUid);
    } catch (_) {}
  }

  return revoked || { ...publicKey(existing), revoked: true };
}

async function authenticateKey(secret) {
  if (!secret?.startsWith(KEY_PREFIX)) {
    const err = new Error("Invalid API key");
    err.status = 401;
    throw err;
  }

  const digest = hashApiKey(secret);

  // Auth-backed keys first — works even when gist/Firestore store is down.
  const authUser = await findAuthBackedKey(secret);
  if (authUser) {
    const c = authUser.customClaims || {};
    try {
      const rec = await migrateAuthKeyToStore(authUser, secret);
      if (rec && !rec.revoked && verifyApiKey(secret, rec.key_hash || "")) {
        const owner = await auth().getUser(rec.user_id);
        return { user: rec, owner, ownerUid: rec.user_id, keyId: rec.id };
      }
    } catch (err) {
      // Store unavailable — still authenticate from Auth claims.
      console.warn("authenticateKey: store migrate skipped:", err.message);
      const ownerUid = c.sc_owner;
      if (ownerUid && verifyApiKey(secret, c.sc_hash || "")) {
        const owner = await auth().getUser(ownerUid);
        const rec = {
          id: authUser.uid,
          user_id: ownerUid,
          name: c.sc_name || "Production",
          prefix: c.sc_prefix || secret.slice(0, 16),
          key_hash: c.sc_hash,
          created_at: c.sc_created || authUser.metadata?.creationTime || null,
          last_used_at: c.sc_last || null,
          revoked: false,
        };
        return { user: rec, owner, ownerUid, keyId: rec.id };
      }
    }
  }

  let store;
  try {
    store = await loadStore();
  } catch (err) {
    const e = new Error(
      `API key store unavailable (${err.message}). Retry in a minute, or reconnect from the dashboard.`
    );
    e.status = 503;
    throw e;
  }

  const keyId = store.hash_index[digest];
  let rec = keyId ? store.keys[keyId] : null;

  if (!rec || rec.revoked || !verifyApiKey(secret, rec.key_hash || "")) {
    const err = new Error("Invalid API key");
    err.status = 401;
    throw err;
  }

  const owner = await auth().getUser(rec.user_id);
  return { user: rec, owner, ownerUid: rec.user_id, keyId: rec.id };
}

async function recordUsage(keyRec, owner, compressed, opts = {}) {
  const keyId = keyRec.id || keyRec.uid;
  const ownerUid = owner?.uid || keyRec.user_id;
  const day = new Date().toISOString().slice(0, 10);
  const tokensSaved = Math.max(0, compressed.original_tokens - compressed.kept_tokens);
  const now = new Date().toISOString();
  const crypto = require("crypto");
  const { sanitizeRequestId, applyUsageAndBurn, microsToUsd } = require("./billing-ledger");
  const {
    reportPaygUsage,
    isPaygEnabled,
    isComped,
    isLegacyMetered,
    roundUsd,
    attemptAutoRecharge,
  } = require("./stripe");

  const requestId =
    sanitizeRequestId(opts.requestId) ||
    sanitizeRequestId(opts.idempotencyKey) ||
    crypto.randomUUID();

  const ownerClaims = owner.customClaims || {};

  // Authoritative wallet/quota first — never bump analytics before a durable burn.
  let applied;
  try {
    applied = await applyUsageAndBurn({
      uid: owner.uid,
      tokensIn: compressed.original_tokens,
      tokensOut: compressed.kept_tokens,
      tokensSaved,
      claims: ownerClaims,
      requestId,
    });
  } catch (err) {
    // Positive-but-insufficient balance: recharge once, retry same request id.
    if (err.code === "credits_exhausted") {
      let autoOn = Boolean(ownerClaims.sc_auto_recharge);
      if (!autoOn) {
        try {
          const { loadLedger } = require("./billing-ledger");
          const led = await loadLedger(owner.uid, ownerClaims);
          autoOn = Boolean(led.auto_recharge);
        } catch (_) {}
      }
      if (autoOn) {
        const recharge = await attemptAutoRecharge(owner);
        if (recharge.ok) {
          try {
            const fresh = await auth().getUser(owner.uid);
            owner.customClaims = fresh.customClaims || owner.customClaims;
          } catch (_) {}
          applied = await applyUsageAndBurn({
            uid: owner.uid,
            tokensIn: compressed.original_tokens,
            tokensOut: compressed.kept_tokens,
            tokensSaved,
            claims: owner.customClaims || ownerClaims,
            requestId,
          });
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }

  const ledger = applied.ledger;
  const ownerUsage = {
    month: ledger.month,
    requests: ledger.requests,
    tokens_in: ledger.tokens_in,
    tokens_out: ledger.tokens_out,
    tokens_saved: ledger.tokens_saved,
    tokens_reported: ledger.tokens_reported || 0,
  };

  // Per-key analytics only after successful (or idempotent replay) billing.
  // Skip on replay so timeout→retry does not inflate dashboard counters twice.
  if (!applied.already) {
    let durableOk = false;
    try {
      const { trackKeyUsage } = require("./store");
      await trackKeyUsage(ownerUid, keyRec, {
        day,
        original_tokens: compressed.original_tokens,
        kept_tokens: compressed.kept_tokens,
        tokens_saved: tokensSaved,
      });
      durableOk = true;
    } catch (err) {
      console.warn("recordUsage: durable key_usage skipped:", err.message);
    }

    try {
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
        if (durableOk) return store.keys[keyId];
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
        u.tokens_in += compressed.original_tokens;
        u.tokens_out += compressed.kept_tokens;
        u.tokens_saved += tokensSaved;
        return u;
      });
    } catch (err) {
      console.warn("recordUsage: store update skipped:", err.message);
    }

    if (String(keyId).startsWith(KEY_UID_PREFIX)) {
      try {
        const stub = await auth().getUser(keyId).catch(() => null);
        if (stub?.customClaims?.sc_api_key) {
          await auth().setCustomUserClaims(keyId, {
            ...stub.customClaims,
            sc_last: now,
          });
        }
      } catch (_) {}
    }
  }

  // Legacy metered: report to Stripe meters (idempotent watermark on ledger).
  try {
    if (isPaygEnabled(ownerClaims.sc_plan) && isLegacyMetered(ownerClaims) && !isComped(ownerClaims)) {
      const freshOwner = {
        ...owner,
        customClaims: {
          ...ownerClaims,
          sc_usage: ownerUsage,
          sc_credit_balance_usd: ledger
            ? roundUsd(microsToUsd(ledger.credit_balance_micros))
            : ownerClaims.sc_credit_balance_usd,
        },
      };
      const reported = await reportPaygUsage(freshOwner, ownerUsage.tokens_in);
      if (reported?.tokens_reported != null) {
        ownerUsage.tokens_reported = reported.tokens_reported;
      }
    }
  } catch (err) {
    console.warn("PAYG meter skipped:", err.message || err);
  }

  try {
    const fresh = await auth().getUser(owner.uid);
    owner.customClaims = fresh.customClaims || {
      ...ownerClaims,
      sc_usage: ownerUsage,
      ...(ledger
        ? { sc_credit_balance_usd: roundUsd(microsToUsd(ledger.credit_balance_micros)) }
        : {}),
    };
  } catch (_) {
    owner.customClaims = {
      ...ownerClaims,
      sc_usage: ownerUsage,
      ...(ledger
        ? { sc_credit_balance_usd: roundUsd(microsToUsd(ledger.credit_balance_micros)) }
        : {}),
    };
  }
  ownerUsage.request_id = requestId;
  ownerUsage.billing_already = Boolean(applied.already);
  return ownerUsage;
}

module.exports = {
  listKeys,
  createKey,
  getOwnedKey,
  renameKey,
  revokeKey,
  authenticateKey,
  recordUsage,
  publicKey,
  usageSnapshot,
  KEY_UID_PREFIX,
  migrateAuthKeyToStore,
};
