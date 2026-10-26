/**
 * Public limitcheck invocation counter.
 *
 *   POST /api/limitcheck  { action, surface }  one anonymous ping per runway check
 *   GET  /api/limitcheck                        global totals for limitcheck.supercompress.dev
 *
 * The ping carries no ids, usage numbers, prompts or paths: only which verdict
 * the check returned and whether it came from the CLI or the MCP tool.
 */
const { json, cors, securityHeaders, checkRateLimit, clientIp, readBody } = require("./_lib/http");
const { ACTIONS, SURFACES, bumpLimitcheck, readLimitcheck } = require("./_lib/limitcheck-stats");

const CACHE_MS = 2000;
const PINGS_PER_MINUTE = 30;

let cache = { at: 0, payload: null };

function parseEvent(body) {
  const action = String(body?.action || "").toLowerCase();
  const surface = String(body?.surface || "").toLowerCase();
  return {
    action: ACTIONS.includes(action) ? action : "unknown",
    surface: SURFACES.includes(surface) ? surface : "cli",
  };
}

async function handler(req, res) {
  if (req.method === "OPTIONS") {
    cors(res);
    securityHeaders(res);
    res.status(204).end();
    return;
  }

  if (req.method === "POST") {
    if (!checkRateLimit(`limitcheck:${clientIp(req)}`, PINGS_PER_MINUTE).allowed) {
      return json(res, 429, { ok: false, error: "rate_limited" });
    }
    let body;
    try {
      body = readBody(req);
    } catch {
      body = {};
    }
    try {
      await bumpLimitcheck(parseEvent(body));
      cache.at = 0;
      return json(res, 202, { ok: true });
    } catch (err) {
      console.warn("limitcheck bump failed:", err.message || err);
      return json(res, 503, { ok: false });
    }
  }

  if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });

  const now = Date.now();
  if (!cache.payload || now - cache.at > CACHE_MS) {
    try {
      cache = { at: now, payload: await readLimitcheck() };
    } catch (err) {
      console.warn("limitcheck read failed:", err.message || err);
      if (!cache.payload) return json(res, 503, { ok: false });
    }
  }
  return json(res, 200, { ok: true, ...cache.payload }, { "Cache-Control": "public, max-age=0, s-maxage=2, stale-while-revalidate=10" });
}

module.exports = handler;
module.exports.parseEvent = parseEvent;
