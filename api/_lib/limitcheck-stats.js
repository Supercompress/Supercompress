/**
 * Global limitcheck invocation counter for limitcheck.supercompress.dev.
 *
 * Firestore is off on this project, so counts live in disabled Auth stubs,
 * like global-token-stats.js. Writes are read-modify-write, so they are
 * spread over SHARDS stubs to keep concurrent pings from overwriting each
 * other; reads sum every shard in one getUsers call.
 *
 * Stub uids: sc_stats_lc_0 … sc_stats_lc_7
 * Claims: { lc: { n, go, land, pace, wait, unknown, cli, mcp, at } }
 */
const admin = require("firebase-admin");
const { initFirebaseAdmin } = require("./auth");

const SHARDS = 8;
const SHARD_PREFIX = "sc_stats_lc_";
const ACTIONS = ["go", "land", "pace", "wait", "unknown"];
const SURFACES = ["cli", "mcp"];

function auth() {
  if (!initFirebaseAdmin()) {
    const err = new Error("Firebase Admin is not configured");
    err.status = 503;
    throw err;
  }
  return admin.auth();
}

function emptyStats() {
  return {
    invocations: 0,
    actions: Object.fromEntries(ACTIONS.map((a) => [a, 0])),
    surfaces: Object.fromEntries(SURFACES.map((s) => [s, 0])),
    updated_at: null,
  };
}

function count(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

/** Sum the `lc` claims of every shard. */
function sumShards(claimsList) {
  const out = emptyStats();
  for (const claims of claimsList) {
    const lc = (claims && claims.lc) || {};
    out.invocations += count(lc.n);
    for (const a of ACTIONS) out.actions[a] += count(lc[a]);
    for (const s of SURFACES) out.surfaces[s] += count(lc[s]);
    if (lc.at && (!out.updated_at || lc.at > out.updated_at)) out.updated_at = lc.at;
  }
  return out;
}

function nextClaims(prev = {}, { action, surface }, at = new Date().toISOString()) {
  const lc = prev.lc || {};
  return {
    ...prev,
    lc: {
      ...lc,
      n: count(lc.n) + 1,
      [action]: count(lc[action]) + 1,
      [surface]: count(lc[surface]) + 1,
      at,
    },
  };
}

async function ensureShard(uid) {
  try {
    return await auth().getUser(uid);
  } catch (err) {
    if (err?.code !== "auth/user-not-found") throw err;
    try {
      await auth().createUser({ uid, disabled: true, displayName: "limitcheck public counter" });
    } catch (createErr) {
      if (createErr?.code !== "auth/uid-already-exists") throw createErr;
    }
    return auth().getUser(uid);
  }
}

async function bumpLimitcheck({ action, surface }, shard = Math.floor(Math.random() * SHARDS)) {
  const uid = SHARD_PREFIX + (count(shard) % SHARDS);
  const event = {
    action: ACTIONS.includes(action) ? action : "unknown",
    surface: SURFACES.includes(surface) ? surface : "cli",
  };
  for (let i = 0; ; i++) {
    try {
      const user = await ensureShard(uid);
      await auth().setCustomUserClaims(uid, nextClaims(user.customClaims || {}, event));
      return true;
    } catch (err) {
      if (i === 2) throw err;
    }
  }
}

async function readLimitcheck() {
  const ids = Array.from({ length: SHARDS }, (_, i) => ({ uid: SHARD_PREFIX + i }));
  const { users } = await auth().getUsers(ids);
  return sumShards(users.map((u) => u.customClaims || {}));
}

module.exports = {
  ACTIONS,
  SURFACES,
  SHARDS,
  SHARD_PREFIX,
  emptyStats,
  sumShards,
  nextClaims,
  bumpLimitcheck,
  readLimitcheck,
};
