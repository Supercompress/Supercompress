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
 */
async function createAuthPluginKey(ownerUid, name = "Coding agent") {
  await auth().getUser(ownerUid); // ensure owner exists
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

  // Index on owner for dashboard listing when store is down
  try {
    const owner = await auth().getUser(ownerUid);
    const claims = { ...(owner.customClaims || {}) };
    const ids = Array.isArray(claims.sc_key_ids) ? claims.sc_key_ids.slice() : [];
    if (!ids.includes(gen.uid)) ids.push(gen.uid);
    // Keep last 20 plugin/key ids
    claims.sc_key_ids = ids.slice(-20);
    claims.sc_agent_plugin = {
      linked: true,
      linked_at: claims.sc_agent_plugin?.linked_at || created,
      updated_at: created,
      source: "auth-connect",
    };
    await auth().setCustomUserClaims(ownerUid, claims);
  } catch (err) {
    console.warn("createAuthPluginKey: owner claim update skipped:", err.message);
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
    const owner = await auth().getUser(ownerUid);
    const claims = { ...(owner.customClaims || {}) };
    if (Array.isArray(claims.sc_key_ids)) {
      claims.sc_key_ids = claims.sc_key_ids.filter((x) => x !== keyUid);
      await auth().setCustomUserClaims(ownerUid, claims);
    }
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
  await auth().setCustomUserClaims(uid, {
    sc_device_link: true,
    code: String(code).trim().toLowerCase(),
    owner_uid: ownerUid,
    secret,
    source: String(source || "oauth").slice(0, 40),
    agents: Array.isArray(agents) ? agents.slice(0, 20) : [],
    status: "linked",
    linked_at: now,
    created_at: existing?.customClaims?.created_at || now,
  });
  return {
    code: String(code).trim().toLowerCase(),
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
  generateAuthBackedKey,
};
