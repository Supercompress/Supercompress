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

/**
 * Keep work running after the response, via the Vercel request context
 * (what @vercel/functions' waitUntil reads) or the Fly process. Returns false elsewhere.
 */
function runAfterResponse(promise) {
  const ctx = globalThis[Symbol.for("@vercel/request-context")]?.get?.();
  if (typeof ctx?.waitUntil === "function") {
    ctx.waitUntil(promise);
    return true;
  }
  // Fly runs one long-lived process, so the bump can finish after the reply.
  return Boolean(process.env.FLY_APP_NAME);
}

function parseEvent(body) {
  const action = String(body?.action || "").toLowerCase();
  const surface = String(body?.surface || "").toLowerCase();
  return {
    action: ACTIONS.includes(action) ? action : "unknown",
    surface: SURFACES.includes(surface) ? surface : "cli",
  };
}

function createHandler({ bump = bumpLimitcheck, read = readLimitcheck } = {}) {
  return async function handler(req, res) {
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
      // The CLI waits on this ping, so on Vercel answer at once and finish
      // the verified bump (a few Auth round trips) after the response.
      const pending = bump(parseEvent(body)).then(() => {
        cache.at = 0;
      });
      const background = pending.catch((err) => console.warn("limitcheck bump failed:", err.message || err));
      if (runAfterResponse(background)) return json(res, 202, { ok: true });
      try {
        await pending;
        return json(res, 202, { ok: true });
      } catch (err) {
        return json(res, 503, { ok: false });
      }
    }

    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });

    const now = Date.now();
    if (!cache.payload || now - cache.at > CACHE_MS) {
      try {
        cache = { at: now, payload: await read() };
      } catch (err) {
        console.warn("limitcheck read failed:", err.message || err);
        if (!cache.payload) return json(res, 503, { ok: false });
      }
    }
    return json(res, 200, { ok: true, ...cache.payload }, { "Cache-Control": "public, max-age=0, s-maxage=2, stale-while-revalidate=10" });
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.parseEvent = parseEvent;
