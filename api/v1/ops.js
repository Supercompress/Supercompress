/**
 * GET /api/v1/ops  (rewrites: /v1/ops/insights, /v1/ops/otel?export=otel)
 *
 * UNADVERTISED control-plane ops. Returns 404 unless SC_CP_OPS=1.
 * No asks/prompts in payloads — Compression Trace sizes + spend only.
 *
 * Vercel rewrites collapse path to /api/v1/ops, so OTel is selected via
 * `?export=otel` (see vercel.json). Path suffixes still work for direct hits.
 */
"use strict";

const { json, clientIp, checkRateLimit } = require("../_lib/http");
const { bearerToken } = require("../_lib/auth");
const { KEY_PREFIX } = require("../_lib/keys");
const { authenticateKey } = require("../_lib/firebase-key-store");
const {
  isOpsEnabled,
  getOpsInsights,
  getOpsOtel,
  resolveOpsSurface,
} = require("../../services/gateway/ops");

module.exports = async function opsEdge(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET") {
    return json(res, 405, { error: { message: "Method not allowed", type: "invalid_request_error" } });
  }

  if (!isOpsEnabled()) {
    return json(res, 404, { error: { message: "Not found", type: "not_found" } });
  }

  const ip = clientIp(req);
  const ipRl = checkRateLimit(`cpops:ip:${ip}`, 60);
  if (!ipRl.allowed) {
    return json(res, 429, { error: { message: "Rate limit exceeded", type: "rate_limit_error" } });
  }

  const token = bearerToken(req.headers.authorization);
  if (!token || !String(token).startsWith(KEY_PREFIX)) {
    return json(res, 401, {
      error: { message: "Missing or invalid API key", type: "invalid_request_error" },
    });
  }

  let owner;
  try {
    owner = await authenticateKey(token);
  } catch (err) {
    return json(res, 401, {
      error: { message: err.message || "Invalid API key", type: "invalid_request_error" },
    });
  }
  if (!owner) {
    return json(res, 401, {
      error: { message: "Invalid API key", type: "invalid_request_error" },
    });
  }

  const url = new URL(req.url || "/", "http://localhost");
  const surface = resolveOpsSurface(req.url || "/", req.headers || {});
  const orgId = owner.orgId || owner.uid || owner.owner_uid;
  const budget = url.searchParams.get("budget_usd");

  if (surface === "otel") {
    const bundle = getOpsOtel({ org_id: orgId });
    return json(res, 200, bundle);
  }

  const insights = getOpsInsights({
    org_id: orgId,
    budget_usd: budget != null ? Number(budget) : undefined,
  });
  return json(res, 200, insights);
};
