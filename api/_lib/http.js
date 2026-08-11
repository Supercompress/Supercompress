/**
 * Shared HTTP helpers for Vercel serverless routes.
 * Includes rate limiting, body size enforcement, and security headers.
 *
 * Rate limiter: in-process Map (fast) + optional Firestore durable limiter
 * (see rate-limit-durable.js) for multi-instance enforcement.
 * Pair with Vercel Spend Management + Firewall for hard budget caps.
 */

const RATE_LIMIT_WINDOW_MS = 60_000;  // 1-minute window
const MAX_BODY_BYTES = 200_000;       // 200KB max request body

/* ── In-memory rate limiter (sliding window per key) ── */
const rateCounters = new Map();

/**
 * @param {string} key - e.g. "ip:1.2.3.4" or "key:sc_live_xxx"
 * @param {number} maxRequests - max requests per window
 * @param {number} [windowMs] - window in ms, default 60s
 * @returns {{ allowed: boolean, remaining: number, resetMs: number }}
 */
function checkRateLimit(key, maxRequests, windowMs = RATE_LIMIT_WINDOW_MS) {
  const now = Date.now();

  // Periodic cleanup: prevent unbounded Map growth within warm lambda
  if (rateCounters.size > 5000) {
    const cutoff = now - windowMs * 2;
    for (const [k, v] of rateCounters) {
      if (v.windowStart < cutoff) rateCounters.delete(k);
    }
  }

  let entry = rateCounters.get(key);

  if (!entry || (now - entry.windowStart) > windowMs) {
    entry = { windowStart: now, count: 0 };
    rateCounters.set(key, entry);
  }

  entry.count += 1;
  const remaining = Math.max(0, maxRequests - entry.count);
  const resetMs = entry.windowStart + windowMs;

  return {
    allowed: entry.count <= maxRequests,
    remaining,
    resetMs,
    limit: maxRequests,
  };
}

/* ── Helpers ── */

/** Get client IP from Vercel headers (trusted). */
function clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
    || req.headers["x-real-ip"]
    || req.socket?.remoteAddress
    || "unknown";
}

/**
 * Parse a form-encoded (URL-encoded) string into an object.
 * Handles + as space, decodes URI components.
 */
function parseFormEncoded(str) {
  const result = {};
  if (!str) return result;
  const pairs = str.split("&");
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, " "));
    const val = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, " "));
    result[key] = val;
  }
  return result;
}

/**
 * Safely read request body, handling pre-parsed (Vercel default), JSON string,
 * and form-encoded (application/x-www-form-urlencoded) cases.
 * Returns parsed object, or throws 413 if body exceeds MAX_BODY_BYTES.
 */
function estimateBodyBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return MAX_BODY_BYTES + 1;
  }
}

function readBody(req) {
  // Vercel serverless parses JSON bodies before the handler — req.body is already an object
  if (typeof req.body === "object" && req.body !== null && !Array.isArray(req.body)) {
    const bytes = estimateBodyBytes(req.body);
    if (bytes > MAX_BODY_BYTES) {
      const err = new Error(`Request body too large (max ${MAX_BODY_BYTES / 1000}KB)`);
      err.status = 413;
      throw err;
    }
    return req.body;
  }
  // Raw string body (bodyParser disabled or non-JSON content type)
  if (typeof req.body === "string") {
    const bytes = Buffer.byteLength(req.body, "utf8");
    if (bytes > MAX_BODY_BYTES) {
      const err = new Error(`Request body too large (max ${MAX_BODY_BYTES / 1000}KB)`);
      err.status = 413;
      throw err;
    }
    // Support form-encoded POST (simpler curl: -d "context=...&query=...")
    // Determine parsing strategy based on Content-Type, with a fallback heuristic
    const ct = (req.headers["content-type"] || "").toLowerCase();
    const isForm = ct.includes("application/x-www-form-urlencoded");
    const isJson = ct.includes("application/json");
    const trimmed = req.body.trim();
    if (isForm || (!isJson && trimmed !== "" && !trimmed.startsWith("{"))) {
      return parseFormEncoded(trimmed);
    }
    return req.body ? JSON.parse(req.body) : {};
  }
  // null, undefined, or other
  return {};
}

/* ── Response helpers ── */

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-API-Key, Idempotency-Key, X-Request-Id"
  );
}

/** Attach security headers to every response. */
function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload"
  );
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), interest-cohort=()"
  );
}

/** Attach rate-limit headers to a response. */
function rateLimitHeaders(res, { remaining, resetMs, limit }) {
  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(resetMs / 1000)));
}

function json(res, status, body, extraHeaders) {
  cors(res);
  securityHeaders(res);
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      res.setHeader(k, v);
    }
  }
  res.status(status).json(body);
}

/** Convenience: JSON response with rate-limit headers. */
function jsonWithRateLimit(res, status, body, rl) {
  rateLimitHeaders(res, {
    remaining: rl.remaining,
    resetMs: rl.resetMs,
    limit: rl.limit,
  });
  json(res, status, body);
}

function methodNotAllowed(res) {
  json(res, 405, { detail: "Method not allowed" });
}

module.exports = {
  cors,
  json,
  jsonWithRateLimit,
  methodNotAllowed,
  securityHeaders,
  rateLimitHeaders,
  checkRateLimit,
  clientIp,
  readBody,
  MAX_BODY_BYTES,
};
