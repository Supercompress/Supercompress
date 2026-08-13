/**
 * Device-connect + coding-agent API keys via Firebase Auth only.
 * No gist / Firestore monolithic store — avoids GitHub rate-limit connect failures.
 */

const crypto = require("crypto");
const admin = require("firebase-admin");
const { initFirebaseAdmin } = require("./auth");
const { KEY_PREFIX, hashApiKey, verifyApiKey } = require("./keys");

const KEY_UID_PREFIX = "sck_";
const LINK_UID_PREFIX = "sc_lnk_";
const DEFAULT_AUTH_KEY_CAP = 20;

function keyLimitCap(maxKeys) {
  const cap = Number(maxKeys);
  return Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_AUTH_KEY_CAP;
}

function keyLimitReached(activeCount, maxKeys) {
  return Number(activeCount) >= keyLimitCap(maxKeys);
}

function nextOwnerKeyIds(existingIds, newId, maxKeys) {
  const ids = Array.isArray(existingIds) ? existingIds.filter(Boolean) : [];
  if (newId && !ids.includes(newId)) ids.push(newId);
  return ids.slice(-keyLimitCap(maxKeys));
}

function auth() {
  if (!initFirebaseAdmin()) {
    const err = new Error("Firebase Admin is not configured");
    err.status = 503;
    throw err;
  }
  return admin.auth();
}

function linkUidFromCode(code) {
  const digest = crypto
    .createHash("sha256")
    .update(String(code || "").trim().toLowerCase(), "utf8")
    .digest("hex")
    .slice(0, 40);
  return `${LINK_UID_PREFIX}${digest}`;
}

function generateAuthBackedKey() {
  const uid = `${KEY_UID_PREFIX}${crypto.randomBytes(12).toString("hex")}`;
  const secret = crypto
    .randomBytes(18)
    .toString("base64url")
    .replace(/-/g, "x")
    .replace(/_/g, "y")
    .slice(0, 24);
  const full_key = `${KEY_PREFIX}${uid}_${secret}`;
  return {
    uid,
    full_key,
    prefix: full_key.slice(0, 16),
    key_hash: hashApiKey(full_key),
  };
}

/**
 * Mint a coding-agent / CLI key as an Auth stub user.
 * Survives gist/Firestore outages; authenticateKey already understands sck_* keys.
 * Enforces plan maxKeys against the owner's Auth index (do not slice below the cap).
 */
async function createAuthPluginKey(ownerUid, name = "Coding agent", opts = {}) {
  const cap = keyLimitCap(opts.maxKeys);
  await auth().getUser(ownerUid); // ensure owner exists
  const existing = await listAuthPluginKeys(ownerUid).catch(() => []);
  if (keyLimitReached(existing.length, cap)) {
    const err = new Error(`Plan limit reached: ${cap} API keys. Upgrade to increase this limit.`);
    err.status = 429;
    throw err;
  }

  const gen = generateAuthBackedKey();
  const created = new Date().toISOString();
  const displayName = String(name || "Coding agent").trim().slice(0, 80) || "Coding agent";

  await auth().createUser({
    uid: gen.uid,
    disabled: false,
    displayName: `API · ${displayName}`,
  });
  await auth().setCustomUserClaims(gen.uid, {
    sc_api_key: true,
    sc_owner: ownerUid,
    sc_hash: gen.key_hash,
    sc_prefix: gen.prefix,
    sc_name: displayName,
    sc_created: created,
    sc_plugin: true,
  });

  // Index on owner for dashboard listing when store is down.
  // Merge from live claims so this write cannot revert a concurrent wallet update.
  try {
    const { patchUserClaims } = require("./billing-ledger");
    await patchUserClaims(
      ownerUid,
      (live) => ({
        ...live,
        sc_key_ids: nextOwnerKeyIds(live.sc_key_ids, gen.uid, cap),
        sc_agent_plugin: {
          linked: true,
          linked_at: live.sc_agent_plugin?.linked_at || created,
          updated_at: created,
          source: "auth-connect",
        },
      }),
      {
        verify: (after) => Array.isArray(after.sc_key_ids) && after.sc_key_ids.includes(gen.uid),
      }
    );
  } catch (err) {
    console.warn("createAuthPluginKey: owner claim update failed:", err.message);
    try {
      await auth().deleteUser(gen.uid);
    } catch (_) {}
    if (err.status === 429) throw err;
    const fail = new Error("Could not index API key. Retry.");
    fail.status = 503;
    throw fail;
  }

  const listed = await listAuthPluginKeys(ownerUid).catch(() => []);
  if (listed.length > cap) {
    try {
      await revokeAuthPluginKey(ownerUid, gen.uid);
    } catch (_) {}
    const err = new Error(`Plan limit reached: ${cap} API keys. Upgrade to increase this limit.`);
    err.status = 429;
    throw err;
  }

  // Mirror into Firestore store immediately so listKeys/usage attribution work
  // without waiting for the first compress migrate.
  try {
    const { mutateStore } = require("./store");
    await mutateStore((store) => {
      store.keys[gen.uid] = {
        id: gen.uid,
        user_id: ownerUid,
        name: displayName,
        prefix: gen.prefix,
        key_hash: gen.key_hash,
        created_at: created,
        last_used_at: null,
        revoked: false,
        plugin: true,
      };
      store.hash_index[gen.key_hash] = gen.uid;
      if (!store.usage[gen.uid]) store.usage[gen.uid] = {};
      return store.keys[gen.uid];
    });
  } catch (err) {
    console.warn("createAuthPluginKey: store mirror skipped:", err.message);
  }

  return {
    key: {
      id: gen.uid,
      user_id: ownerUid,
      name: displayName,
      prefix: gen.prefix,
      created_at: created,
      last_used_at: null,
      revoked: false,
    },
    secret: gen.full_key,
    full_key: gen.full_key,
  };
}

async function revokeAuthPluginKey(ownerUid, keyUid) {
  if (!String(keyUid || "").startsWith(KEY_UID_PREFIX)) return null;
  const user = await auth().getUser(keyUid).catch(() => null);
  if (!user) return null;
  const c = user.customClaims || {};
  if (c.sc_owner !== ownerUid) {
    const err = new Error("Key not found");
    err.status = 404;
    throw err;
  }
  try {
    await auth().updateUser(keyUid, { disabled: true });
  } catch (_) {}
  try {
    await auth().deleteUser(keyUid);
  } catch (_) {}
  try {
    const { patchUserClaims } = require("./billing-ledger");
    await patchUserClaims(ownerUid, (live) => {
      if (!Array.isArray(live.sc_key_ids)) return live;
      return { ...live, sc_key_ids: live.sc_key_ids.filter((x) => x !== keyUid) };
    });
  } catch (_) {}
  return { id: keyUid, revoked: true };
}

async function listAuthPluginKeys(ownerUid) {
  const owner = await auth().getUser(ownerUid).catch(() => null);
  const ids = Array.isArray(owner?.customClaims?.sc_key_ids)
    ? owner.customClaims.sc_key_ids
    : [];
  const out = [];
  for (const id of ids) {
    const user = await auth().getUser(id).catch(() => null);
    if (!user || user.disabled) continue;
    const c = user.customClaims || {};
    if (!c.sc_api_key || c.sc_owner !== ownerUid) continue;
    out.push({
      id,
      user_id: ownerUid,
      name: c.sc_name || "Coding agent",
      prefix: c.sc_prefix || "",
      created_at: c.sc_created || user.metadata?.creationTime || null,
      last_used_at: c.sc_last || null,
      revoked: false,
    });
  }
  return out;
}

/** Deposit linked device secret for CLI/MCP poll (Auth-only). */
async function putDeviceLink(code, { ownerUid, secret, source = "oauth", agents = [] }) {
  const uid = linkUidFromCode(code);
  const now = new Date().toISOString();
  const existing = await auth().getUser(uid).catch(() => null);
  if (!existing) {
    await auth().createUser({
      uid,
      disabled: true,
      displayName: `Device link ${String(code).slice(0, 8)}`,
    });
  }
  const codeNorm = String(code).trim().toLowerCase();
  await auth().setCustomUserClaims(uid, {
    sc_device_link: true,
    code: codeNorm,
    owner_uid: ownerUid,
    secret,
    source: String(source || "oauth").slice(0, 40),
    agents: Array.isArray(agents) ? agents.slice(0, 20) : [],
    status: "linked",
    linked_at: now,
    created_at: existing?.customClaims?.created_at || now,
  });
  try {
    await admin.firestore().collection("device_links").doc(uid).set(
      {
        code: codeNorm,
        owner_uid: ownerUid,
        secret,
        source: String(source || "oauth").slice(0, 40),
        status: "linked",
        linked_at: now,
        created_at: existing?.customClaims?.created_at || now,
      },
      { merge: true }
    );
  } catch (err) {
    console.warn("putDeviceLink firestore mirror skipped:", err.message || err);
  }
  return {
    code: codeNorm,
    status: "linked",
    owner_uid: ownerUid,
    secret,
    linked_at: now,
  };
}

async function getDeviceLink(code) {
  const uid = linkUidFromCode(code);
  const user = await auth().getUser(uid).catch(() => null);
  if (!user) return null;
  const c = user.customClaims || {};
  if (!c.sc_device_link) return null;
  return {
    code: c.code || String(code).trim().toLowerCase(),
    status: c.secret ? "linked" : "pending",
    owner_uid: c.owner_uid || null,
    secret: c.secret || null,
    linked_at: c.linked_at || null,
    created_at: c.created_at || null,
  };
}

/** Best-effort cleanup after CLI has consumed the secret. */
async function clearDeviceLinkSecret(code) {
  const uid = linkUidFromCode(code);
  const user = await auth().getUser(uid).catch(() => null);
  if (!user) return;
  const c = { ...(user.customClaims || {}) };
  if (!c.sc_device_link) return;
  delete c.secret;
  c.status = "consumed";
  c.consumed_at = new Date().toISOString();
  await auth().setCustomUserClaims(uid, c);
}

/**
 * Atomically take the device-link secret (single-use).
 * Prefers a Firestore transaction; falls back to Auth clear-then-return.
 * Returns { secret, owner_uid, linked_at, created_at } or null if already consumed.
 */
async function consumeDeviceLinkSecret(code) {
  const normalized = String(code || "").trim().toLowerCase();
  if (!normalized) return null;

  // Firestore CAS when available
  try {
    const { initFirebaseAdmin } = require("./auth");
    if (initFirebaseAdmin()) {
      const db = admin.firestore();
      const ref = db.collection("device_links").doc(linkUidFromCode(normalized));
      const taken = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return null;
        const data = snap.data() || {};
        if (!data.secret) return null;
        const out = {
          secret: data.secret,
          owner_uid: data.owner_uid || null,
          linked_at: data.linked_at || null,
          created_at: data.created_at || null,
        };
        tx.set(
          ref,
          {
            ...data,
            secret: null,
            status: "consumed",
            consumed_at: new Date().toISOString(),
          },
          { merge: true }
        );
        return out;
      });
      if (taken) {
        try { await clearDeviceLinkSecret(normalized); } catch (_) {}
        return taken;
      }
    }
  } catch (err) {
    console.warn("consumeDeviceLinkSecret firestore path:", err.message || err);
  }

  // Auth fallback: read → clear → return (still a small race under Auth-only).
  const status = await getDeviceLink(normalized);
  if (!status?.secret) return null;
  const secret = status.secret;
  await clearDeviceLinkSecret(normalized);
  return {
    secret,
    owner_uid: status.owner_uid || null,
    linked_at: status.linked_at || null,
    created_at: status.created_at || null,
  };
}

module.exports = {
  KEY_UID_PREFIX,
  LINK_UID_PREFIX,
  linkUidFromCode,
  createAuthPluginKey,
  revokeAuthPluginKey,
  listAuthPluginKeys,
  putDeviceLink,
  getDeviceLink,
  clearDeviceLinkSecret,
  consumeDeviceLinkSecret,
  generateAuthBackedKey,
  nextOwnerKeyIds,
  keyLimitReached,
  keyLimitCap,
};
