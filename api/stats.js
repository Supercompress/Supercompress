/**
 * Public growth stats.
 *
 * npm "weekly downloads" ≠ unique humans. Publish days, mirrors, CI, and
 * reinstalls inflate that number. Signed-up users = Firebase Auth accounts
 * with an email (real humans who finished dashboard / setup connect).
 */
const { json } = require("./_lib/http");
const { initFirebaseAdmin } = require("./_lib/auth");
const admin = require("firebase-admin");

const PACKAGES = ["supercompress-proxy", "@agents-npm-packages/supercompress"];
const CACHE_MS = 30 * 60 * 1000;
let cache = { at: 0, payload: null };

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

async function countSignedUpUsers() {
  if (!initFirebaseAdmin()) return null;
  const auth = admin.auth();
  let pageToken;
  let withEmail = 0;
  let total = 0;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      total += 1;
      if (user.email || user.providerData?.some((p) => p.email)) withEmail += 1;
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return { total_auth_records: total, signed_up_users: withEmail };
}

function fmtDownloads(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "")}k+`;
  return String(n);
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method !== "GET") return json(res, 405, { detail: "Method not allowed", allow: "GET" });

  try {
    if (cache.payload && Date.now() - cache.at < CACHE_MS) {
      return json(res, 200, { ...cache.payload, cached: true });
    }

    const npmRows = await Promise.all(PACKAGES.map((p) => npmWeek(p).catch(() => null)));
    const npm = npmRows.filter(Boolean);
    const npmDownloadsWeek = npm.reduce((s, r) => s + r.downloads, 0);
    const primary = npm.find((r) => r.package === "supercompress-proxy") || npm[0];

    let users = null;
    try {
      users = await countSignedUpUsers();
    } catch (err) {
      console.warn("stats: auth count failed", err.message || err);
    }

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
      signed_up_users: users?.signed_up_users ?? null,
      auth_records: users?.total_auth_records ?? null,
      note:
        "npm weekly downloads count install events (mirrors, CI, reinstalls, version bumps) — not unique people. signed_up_users = Firebase Auth accounts with email who finished signup/connect.",
      updated_at: new Date().toISOString(),
    };

    cache = { at: Date.now(), payload };
    return json(res, 200, { ...payload, cached: false });
  } catch (err) {
    console.error("stats error", err);
    return json(res, 500, { ok: false, detail: err.message || String(err) });
  }
};
