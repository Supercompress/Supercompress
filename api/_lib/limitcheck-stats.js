/**
 * Global limitcheck invocation counter for limitcheck.supercompress.dev.
 *
 * Firestore is off and the project has no Storage bucket or Redis, so counts
 * live in disabled Auth stubs, like global-token-stats.js. Auth claims are
 * last-write-wins with no compare-and-swap, so a bump is made safe by hand:
 * pings are spread over SHARDS stubs, each write records a nonce in a short
 * list of recent writers, and the writer re-reads after VERIFY_MS. If its
 * nonce is gone while fewer than RECENT writes have landed since, a
 * concurrent writer overwrote it and the bump is retried. Reads sum every
 * shard in one getUsers call.
 *
 * Stub uids: sc_stats_lc_0 … sc_stats_lc_15
 * Claims: { lc: { n, go, land, pace, wait, unknown, cli, mcp, at, r: [nonce…] } }
 */
const crypto = require("crypto");
const admin = require("firebase-admin");
const { initFirebaseAdmin } = require("./auth");

const SHARDS = 16;
const RECENT = 12;
const VERIFY_MS = 300;
const ATTEMPTS = 4;
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

function nextClaims(prev = {}, { action, surface }, at = new Date().toISOString(), nonce = newNonce()) {
  const lc = prev.lc || {};
  const recent = Array.isArray(lc.r) ? lc.r.filter((x) => typeof x === "string") : [];
  return {
    ...prev,
    lc: {
      ...lc,
      n: count(lc.n) + 1,
      [action]: count(lc[action]) + 1,
      [surface]: count(lc[surface]) + 1,
      at,
      r: [nonce, ...recent].slice(0, RECENT),
    },
  };
}

function newNonce() {
  return crypto.randomBytes(5).toString("hex");
}

/** True unless a concurrent writer replaced our write (see header). */
function writeLanded(current = {}, written) {
  const lc = current.lc || {};
  if (Array.isArray(lc.r) && lc.r.includes(written.nonce)) return true;
  return count(lc.n) - written.n >= RECENT;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function bumpLimitcheck({ action, surface }, shard = Math.floor(Math.random() * SHARDS), opts = {}) {
  const verifyMs = opts.verifyMs ?? VERIFY_MS;
  const event = {
    action: ACTIONS.includes(action) ? action : "unknown",
    surface: SURFACES.includes(surface) ? surface : "cli",
  };
  let lastErr = null;
  for (let i = 0; i < ATTEMPTS; i++) {
    // Retries move to another shard, away from whoever we collided with.
    const uid = SHARD_PREFIX + ((count(shard) + i * 7) % SHARDS);
    try {
      const user = await ensureShard(uid);
      const nonce = newNonce();
      const claims = nextClaims(user.customClaims || {}, event, new Date().toISOString(), nonce);
      await auth().setCustomUserClaims(uid, claims);
      await sleep(verifyMs + Math.floor(Math.random() * 100));
      // Only retry on proof of an overwrite. If the check itself fails, the
      // write may well have landed, and retrying could count this ping twice.
      const after = await auth().getUser(uid).catch(() => null);
      if (!after || writeLanded(after.customClaims || {}, { nonce, n: claims.lc.n })) return true;
      lastErr = new Error("concurrent write replaced this bump");
    } catch (err) {
      lastErr = err;
    }
    await sleep(Math.floor(Math.random() * 150) * (i + 1));
  }
  throw lastErr || new Error("limitcheck bump failed");
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
  writeLanded,
  RECENT,
  bumpLimitcheck,
  readLimitcheck,
};
