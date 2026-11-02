/**
 * GET /v1/models  and  GET /v1/models/{id}
 *
 * OpenAI-compatible model list for the control-plane gateway: the models this deployment
 * can route to (catalog entries whose provider is configured). 404 unless SC_CP_GATEWAY=1.
 * Requires an API key, like the rest of the gateway.
 */
"use strict";

const { json, clientIp, checkRateLimit } = require("../_lib/http");
const { bearerToken } = require("../_lib/auth");
const { KEY_PREFIX } = require("../_lib/keys");
const { authenticateKey } = require("../_lib/firebase-key-store");
const { isGatewayEnabled } = require("../../services/gateway/http");
const { catalogFromEnv } = require("../../services/gateway/catalog-env");
const { normalizeCatalog } = require("../../packages/control-plane");

// Fixed timestamp: the catalog has no per-model creation date.
const CREATED = 1767225600; // 2026-01-01T00:00:00Z

function modelObject(m) {
  return {
    id: m.id,
    object: "model",
    created: CREATED,
    owned_by: m.provider,
    context_window: m.max_context_tokens,
    capabilities: m.capabilities,
  };
}

function notFound(res, message = "Not found") {
  return json(res, 404, { error: { message, type: "not_found_error", code: null, param: null } });
}

module.exports = async function models(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (!isGatewayEnabled()) return notFound(res);
  if (req.method !== "GET") {
    return json(res, 405, { error: { message: "Method not allowed", type: "invalid_request_error" } });
  }
  const rl = checkRateLimit(`cpmodels:ip:${clientIp(req)}`, 120);
  if (!rl.allowed) {
    res.setHeader("Retry-After", "1");
    return json(res, 429, { error: { message: "Rate limit exceeded", type: "rate_limit_error" } });
  }
  const token = bearerToken(req.headers.authorization);
  if (!token || !String(token).startsWith(KEY_PREFIX)) {
    return json(res, 401, { error: { message: "Missing or invalid API key", type: "authentication_error" } });
  }
  let owner = null;
  try {
    owner = await authenticateKey(token);
  } catch (_) {
    owner = null;
  }
  if (!owner) {
    return json(res, 401, { error: { message: "Invalid API key", type: "authentication_error" } });
  }

  const catalog = normalizeCatalog(catalogFromEnv(process.env));
  const url = new URL(req.url || "/", "http://localhost");
  const m = /\/models\/(.+)$/.exec(url.pathname);
  const id = m ? decodeURIComponent(m[1]) : url.searchParams.get("id");
  if (id) {
    const entry = catalog.get(id);
    return entry ? json(res, 200, modelObject(entry)) : notFound(res, `The model '${id}' does not exist`);
  }
  return json(res, 200, { object: "list", data: catalog.models.map(modelObject) });
};

module.exports.modelObject = modelObject;
