/**
 * Public growth stats.
 *
 * npm "weekly downloads" ≠ unique humans. Publish days, mirrors, CI, and
 * reinstalls inflate that number. Signed-up users = Firebase Auth accounts
 * with an email (real humans who finished dashboard / setup connect).
 *
 * tokens_processed prefers the O(1) global Auth stub (sc_stats_total),
 * bumped on every successful compress burn. Auth listUsers is only used
 * to seed / periodically resync that stub.
 */
const { json } = require("./_lib/http");
const { initFirebaseAdmin } = require("./_lib/auth");
const { isHumanUser } = require("./_lib/founder-usage");
const {
  STATS_UID,
  readGlobalTokenStats,
  seedGlobalTokenStats,
} = require("./_lib/global-token-stats");
const admin = require("firebase-admin");

const PACKAGES = ["supercompress-proxy", "@agents-npm-packages/supercompress"];
/** Fast path for live homepage meter (global stub read). */
const LIVE_CACHE_MS = 1000;
/** Full npm + Auth-user scan. */
const FULL_CACHE_MS = 60 * 1000;
/** How often to re-scan Auth into the stub even when live cache is warm. */
const RESYNC_MS = 15 * 60 * 1000;

let liveCache = { at: 0, payload: null };
let fullCache = { at: 0, payload: null };
let lastResyncAt = 0;

async function npmWeek(pkg) {
  const url = `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(pkg)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`npm ${pkg} ${res.status}`);
  const data = await res.json();
  return {
    package: pkg,
    downloads: Number(data.downloads) || 0,
    start: data.start || null,
    end: data.end || null,
  };
}

function accountProcessed(claims = {}) {
  const u = claims.sc_usage || {};
  const life = Number(u.life_in || 0) || 0;
  const month = Number(u.tokens_in || 0) || 0;
  const lifeSaved = Number(u.life_saved || 0) || 0;
  const monthSaved = Number(u.tokens_saved || 0) || 0;
  return {
    tokens_in: Math.max(life, month),
    tokens_saved: Math.max(lifeSaved, monthSaved),
  };
}

async function scanAuthGrowth() {
  if (!initFirebaseAdmin()) return null;
  const auth = admin.auth();
  let pageToken;
  let withEmail = 0;
  let total = 0;
  let tokens_processed = 0;
  let tokens_saved = 0;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      if (user.uid === STATS_UID || user.uid.startsWith("sc_stats_")) continue;
      total += 1;
      if (!isHumanUser(user)) continue;
      if (user.email || user.providerData?.some((p) => p.email)) withEmail += 1;
      const rec = accountProcessed(user.customClaims || {});
      tokens_processed += rec.tokens_in;
      tokens_saved += rec.tokens_saved;
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return {
    total_auth_records: total,
    signed_up_users: withEmail,
    tokens_processed,
    tokens_saved,
  };
}

function fmtDownloads(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "")}k+`;
  return String(n);
}

/** Compact label for API consumers — UI always uses full comma numbers. */
function fmtTokens(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1e9) return `${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1).replace(/\.0$/, "")}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(Math.round(v));
}

function fmtFull(n) {
  return Math.max(0, Math.round(Number(n) || 0)).toLocaleString("en-US");
}

async function resolveTokenTotals({ forceResync = false } = {}) {
  const stub = await readGlobalTokenStats().catch(() => null);
  const stubReady = Boolean(stub && stub.seeded && stub.tokens_processed > 0);
  const stubAgeMs = stub?.updated_at
    ? Math.max(0, Date.now() - Date.parse(stub.updated_at))
    : Number.POSITIVE_INFINITY;
  // Prefer Auth stub claims age over lambda memory — cold starts must not
  // re-listUsers every request when the stub is already seeded.
  const due =
    forceResync ||
    !stubReady ||
    stubAgeMs > RESYNC_MS ||
    (lastResyncAt > 0 && Date.now() - lastResyncAt > RESYNC_MS);

  if (stubReady && !forceResync && stubAgeMs <= RESYNC_MS) {
    return {
      tokens_processed: stub.tokens_processed,
      tokens_saved: stub.tokens_saved,
      source: "global_stub",
      signed_up_users: null,
      auth_records: null,
    };
  }

  if (stubReady && !due) {
    return {
      tokens_processed: stub.tokens_processed,
      tokens_saved: stub.tokens_saved,
      source: "global_stub",
      signed_up_users: null,
      auth_records: null,
    };
  }

  let growth = null;
  try {
    growth = await scanAuthGrowth();
    lastResyncAt = Date.now();
  } catch (err) {
    console.warn("stats: auth scan failed", err.message || err);
  }

  if (growth) {
    try {
      await seedGlobalTokenStats({
        tokens_processed: growth.tokens_processed,
        tokens_saved: growth.tokens_saved,
      });
    } catch (err) {
      console.warn("stats: seed failed", err.message || err);
    }
  }

  const after = await readGlobalTokenStats().catch(() => null);
  const tin =
    after?.tokens_processed ??
    growth?.tokens_processed ??
    stub?.tokens_processed ??
    null;
  const ts =
    after?.tokens_saved ?? growth?.tokens_saved ?? stub?.tokens_saved ?? null;

  return {
    tokens_processed: tin,
    tokens_saved: ts,
    source: growth ? "auth_scan" : stubReady ? "global_stub" : "none",
    signed_up_users: growth?.signed_up_users ?? null,
    auth_records: growth?.total_auth_records ?? null,
  };
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method !== "GET") return json(res, 405, { detail: "Method not allowed", allow: "GET" });

  try {
    const fresh = String(req.query?.fresh || "") === "1";
    const resync = String(req.query?.resync || "") === "1";

    // Homepage live meter: short cache, stub-only token refresh (skip npm).
    if (
      fresh &&
      !resync &&
      liveCache.payload &&
      Date.now() - liveCache.at < LIVE_CACHE_MS
    ) {
      return json(res, 200, { ...liveCache.payload, cached: true });
    }

    if (fresh && !resync && liveCache.payload) {
      const tokens = await resolveTokenTotals({ forceResync: false });
      const tokensProcessed = tokens.tokens_processed;
      const tokensSaved = tokens.tokens_saved;
      const payload = {
        ...liveCache.payload,
        tokens_processed: tokensProcessed,
        tokens_processed_label:
          tokensProcessed == null ? null : fmtTokens(tokensProcessed),
        tokens_processed_full:
          tokensProcessed == null ? null : fmtFull(tokensProcessed),
        tokens_saved: tokensSaved,
        tokens_saved_label: tokensSaved == null ? null : fmtTokens(tokensSaved),
        tokens_saved_full: tokensSaved == null ? null : fmtFull(tokensSaved),
        tokens_source: tokens.source,
        updated_at: new Date().toISOString(),
      };
      if (tokens.signed_up_users != null) payload.signed_up_users = tokens.signed_up_users;
      if (tokens.auth_records != null) payload.auth_records = tokens.auth_records;
      liveCache = { at: Date.now(), payload };
      return json(res, 200, { ...payload, cached: false });
    }

    if (!fresh && !resync && fullCache.payload && Date.now() - fullCache.at < FULL_CACHE_MS) {
      return json(res, 200, { ...fullCache.payload, cached: true });
    }

    const npmRows = await Promise.all(PACKAGES.map((p) => npmWeek(p).catch(() => null)));
    const npm = npmRows.filter(Boolean);
    const npmDownloadsWeek = npm.reduce((s, r) => s + r.downloads, 0);
    const primary = npm.find((r) => r.package === "supercompress-proxy") || npm[0];

    const tokens = await resolveTokenTotals({ forceResync: resync });

    const signed =
      tokens.signed_up_users ??
      fullCache.payload?.signed_up_users ??
      liveCache.payload?.signed_up_users ??
      null;
    const authRecords =
      tokens.auth_records ??
      fullCache.payload?.auth_records ??
      liveCache.payload?.auth_records ??
      null;

    const tokensProcessed = tokens.tokens_processed;
    const tokensSaved = tokens.tokens_saved;

    const payload = {
      ok: true,
      npm_downloads_week: npmDownloadsWeek,
      npm_downloads_week_label: fmtDownloads(npmDownloadsWeek),
      npm_primary: primary
        ? {
            package: primary.package,
            downloads: primary.downloads,
            label: fmtDownloads(primary.downloads),
            start: primary.start,
            end: primary.end,
          }
        : null,
      npm_packages: npm,
      signed_up_users: signed,
      auth_records: authRecords,
      tokens_processed: tokensProcessed,
      tokens_processed_label: tokensProcessed == null ? null : fmtTokens(tokensProcessed),
      tokens_processed_full:
        tokensProcessed == null ? null : fmtFull(tokensProcessed),
      tokens_saved: tokensSaved,
      tokens_saved_label: tokensSaved == null ? null : fmtTokens(tokensSaved),
      tokens_saved_full: tokensSaved == null ? null : fmtFull(tokensSaved),
      tokens_source: tokens.source,
      note:
        "tokens_processed is the live global meter (Auth stub sc_stats_total), seeded from account meters and bumped on compress. npm weekly downloads count install events — not unique people. signed_up_users = Firebase Auth accounts with email.",
      updated_at: new Date().toISOString(),
    };

    liveCache = { at: Date.now(), payload };
    fullCache = { at: Date.now(), payload };
    return json(res, 200, { ...payload, cached: false });
  } catch (err) {
    console.error("stats error", err);
    return json(res, 500, { ok: false, detail: err.message || String(err) });
  }
};

module.exports._test = { accountProcessed, fmtTokens, fmtFull };
