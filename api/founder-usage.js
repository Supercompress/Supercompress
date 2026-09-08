/**
 * GET /api/founder-usage — all-account usage for founder admin.
 */
const { json } = require("./_lib/http");
const { verifyUser, initFirebaseAdmin } = require("./_lib/auth");
const { isFounderUser } = require("./_lib/founder");
const {
  monthKey,
  isHumanUser,
  rowFromUser,
  summarizeRows,
  mergeStoreDays,
  mergeRowDays,
  analyticsBundle,
} = require("./_lib/founder-usage");

const CACHE_MS = 45_000;
let cache = { at: 0, payload: null };

async function scanAuthRows(month) {
  const admin = require("firebase-admin");
  if (!initFirebaseAdmin()) {
    const err = new Error("Firebase admin not configured");
    err.status = 503;
    throw err;
  }
  const rows = [];
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    for (const user of page.users) {
      if (!isHumanUser(user)) continue;
      rows.push(rowFromUser(user, month));
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return rows;
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method !== "GET") return json(res, 405, { detail: "Method not allowed", allow: "GET" });

  try {
    const user = await verifyUser(req);
    if (!isFounderUser(user)) {
      return json(res, 403, { detail: "Access denied. Founder access only." });
    }

    if (cache.payload && Date.now() - cache.at < CACHE_MS && req.query?.fresh !== "1") {
      return json(res, 200, { ...cache.payload, cached: true });
    }

    const month = monthKey();
    const rows = await scanAuthRows(month);
    const summary = summarizeRows(rows, month);

    let byDay = mergeRowDays(rows);
    try {
      const { loadStore } = require("./_lib/store");
      const store = await loadStore({ forceRemote: false });
      const { mergeDays } = require("./_lib/usage-days");
      byDay = mergeDays(byDay, mergeStoreDays(store));
    } catch (_) {}

    const payload = {
      ok: true,
      ...summary,
      by_day: byDay,
      analytics: analyticsBundle({
        totals: summary.totals,
        leaderboard: summary.leaderboard,
        plans: summary.plans,
        byDay,
      }),
      updated_at: new Date().toISOString(),
    };
    cache = { at: Date.now(), payload };
    return json(res, 200, { ...payload, cached: false });
  } catch (err) {
    return json(res, err.status || 500, { ok: false, detail: err.message || "Failed to load usage." });
  }
};
