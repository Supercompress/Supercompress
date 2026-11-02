/**
 * POST /api/v1/chat/completions  (also /v1/chat/completions)
 *
 * Control-plane gateway. Returns 404 unless SC_CP_GATEWAY=1.
 * OpenAI-compatible shape. Server-side provider keys only.
 * Never compresses the user ask (gateway compress stage).
 * In production, model spend is paid from the account's prepaid credits (api/_lib/cp-billing).
 */
"use strict";

const { json, readBody, clientIp, checkRateLimit } = require("../_lib/http");
const { bearerToken } = require("../_lib/auth");
const { KEY_PREFIX } = require("../_lib/keys");
const { authenticateKey } = require("../_lib/firebase-key-store");
const {
  isGatewayEnabled,
  writeOpenAiSse,
  getProcessGateway,
} = require("../../services/gateway/http");

const RPM = 60;
/** Agent contexts and base64 images are large; keep in sync with services/api/routes.js. */
const CHAT_MAX_BODY_BYTES = 16 * 1024 * 1024;

const ERROR_TYPES = {
  400: "invalid_request_error",
  401: "authentication_error",
  402: "insufficient_quota",
  403: "permission_error",
  404: "not_found_error",
  409: "conflict_error",
  429: "rate_limit_error",
};

/**
 * Gateway outcome → HTTP status. Rejections are not all payment problems: rate limits are
 * 429, an unavailable money/billing store is 503, idempotency conflicts are 409.
 */
function statusFor(error = {}) {
  const msg = String(error.message || "");
  const code = String(error.code || "");
  if (msg === "auth_required" || code === "auth_required") return 401;
  if (error.status && error.status >= 400 && error.status < 600 && error.status !== 499) return error.status;
  if (/rpm_exceeded|tpm_exceeded|rate_limited/.test(msg)) return 429;
  if (/unavailable/.test(msg) || /unavailable/.test(code)) return 503;
  if (/model_not_allowed|model_denied|model_not_found/.test(msg)) return 400;
  if (/no_viable_model|post_compress_usd/.test(msg)) return 422;
  if (error.class === "rejected") return 402;
  return 502;
}

function openAiError(res, status, message, extra = {}) {
  if (status === 429 || status === 503) res.setHeader("Retry-After", String(extra.retryAfter || 1));
  return json(res, status, {
    error: {
      message,
      type: ERROR_TYPES[status] || (status >= 500 ? "server_error" : "invalid_request_error"),
      code: extra.code || null,
      param: extra.param || null,
    },
    ...(extra.request_id ? { sc_request_id: extra.request_id } : {}),
  });
}

function logRequest(fields) {
  // One structured line per request. Never prompts, completions or key material.
  try {
    console.log(JSON.stringify({ evt: "cp_chat", ...fields }));
  } catch (_) {
    /* never fail a request on logging */
  }
}

function gatewayBilling() {
  if (process.env.NODE_ENV !== "production" && process.env.SC_CP_BILLING !== "credits") return null;
  return require("../_lib/cp-billing").processCreditBilling();
}

module.exports = async function chatCompletions(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    return json(res, 405, { error: { message: "Method not allowed", type: "invalid_request_error" } });
  }

  // Fail closed / invisible when flag off — do not advertise the control plane.
  if (!isGatewayEnabled()) {
    return json(res, 404, { error: { message: "Not found", type: "not_found" } });
  }

  const ip = clientIp(req);
  const ipRl = checkRateLimit(`cpgw:ip:${ip}`, 120);
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

  // authenticateKey returns { ownerUid, keyId }: the tenant is the key's owner account.
  const orgId = owner.ownerUid || owner.owner?.uid || null;
  const keyId = owner.keyId || null;
  if (!orgId || !keyId) {
    return openAiError(res, 401, "Invalid API key", { code: "invalid_api_key" });
  }
  const keyRl = checkRateLimit(`cpgw:key:${keyId}`, RPM);
  if (!keyRl.allowed) {
    return json(res, 429, { error: { message: "Rate limit exceeded", type: "rate_limit_error" } });
  }

  let body;
  try {
    body = await readBody(req, { maxBytes: CHAT_MAX_BODY_BYTES });
  } catch (err) {
    return json(res, 400, {
      error: { message: err.message || "Invalid body", type: "invalid_request_error" },
    });
  }
  if (!body || typeof body !== "object") {
    return json(res, 400, {
      error: { message: "JSON body required", type: "invalid_request_error" },
    });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return openAiError(res, 400, "messages must be a non-empty array", { param: "messages" });
  }
  if (typeof body.model !== "string" || !body.model) {
    return openAiError(res, 400, "model is required", { param: "model" });
  }

  const gw = getProcessGateway({ billing: gatewayBilling() });
  const auth = {
    org_id: orgId,
    key_id: keyId,
    agent_id: body.metadata?.agent_id,
  };

  // Stop the upstream call when the client goes away.
  const abort = new AbortController();
  res.on?.("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  const t0 = Date.now();
  let ctx;
  try {
    ctx = await gw.handleChatCompletions(body, auth, { abort_signal: abort.signal });
  } catch (err) {
    console.error("[cp] gateway_error", err?.code || err?.message);
    logRequest({ status: 500, key_id: keyId, ms: Date.now() - t0, err: err?.code || "gateway_error" });
    return openAiError(res, 500, "Internal gateway error", { code: "gateway_error" });
  }

  const logBase = {
    request_id: ctx.request_id,
    org: orgId,
    key_id: keyId,
    model_requested: body.model,
    model_routed: ctx.model_routed,
    provider: ctx.provider_name,
    stream: body.stream === true,
    tokens_saved: ctx.compression?.tokens_saved,
  };

  if (ctx.aborted) {
    const status = statusFor(ctx.error);
    logRequest({ ...logBase, status, err: ctx.error?.code || ctx.error?.message, ms: Date.now() - t0 });
    if (status >= 500) console.error("[cp] request failed", ctx.request_id, ctx.error?.message);
    return openAiError(res, status, ctx.error?.message || "request_aborted", {
      code: ctx.error?.code,
      request_id: ctx.request_id,
    });
  }

  if (body.stream === true) {
    try {
      await writeOpenAiSse(res, ctx);
    } finally {
      if (typeof gw.finalizeDeferred === "function") {
        await gw.finalizeDeferred(ctx).catch((err) => {
          console.error("[cp] finalize failed", ctx.request_id, err?.message);
        });
      }
      logRequest({
        ...logBase,
        status: ctx.aborted ? statusFor(ctx.error) : 200,
        usd: ctx.actual_usd,
        err: ctx.aborted ? ctx.error?.code || ctx.error?.message : undefined,
        ms: Date.now() - t0,
      });
    }
    return;
  }

  logRequest({ ...logBase, status: 200, usd: ctx.actual_usd, ms: Date.now() - t0 });
  // Non-stream: finalize already ran inside the pipeline.
  return json(res, 200, ctx.openai || { error: { message: "empty_response" } });
};

module.exports.statusFor = statusFor;
module.exports.CHAT_MAX_BODY_BYTES = CHAT_MAX_BODY_BYTES;
