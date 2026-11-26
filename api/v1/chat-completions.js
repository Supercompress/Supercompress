/**
 * POST /api/v1/chat/completions  (also /v1/chat/completions)
 *
 * Control-plane gateway. Returns 404 unless SC_CP_GATEWAY=1.
 * OpenAI-compatible shape. Server-side provider keys only.
 * Never compresses the user ask (gateway compress stage).
 * In production, model spend is paid from the account's prepaid credits (api/_lib/cp-billing).
 */
"use strict";

const crypto = require("crypto");
const { json, readBody, clientIp, checkRateLimit } = require("../_lib/http");
const { bearerToken } = require("../_lib/auth");
const { KEY_PREFIX } = require("../_lib/keys");
const { authenticateKey } = require("../_lib/firebase-key-store");
const {
  isGatewayEnabled,
  writeOpenAiSse,
  getProcessGateway,
} = require("../../services/gateway/http");
const { httpStatusFor, errorCode } = require("../../packages/control-plane/request-obs");

/** Header carrying the request id customers quote to support (also on every error). */
const REQUEST_ID_HEADER = "x-sc-request-id";

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
  return httpStatusFor(error);
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
  // One structured line per request. Never prompts, completions or key material:
  // only ids, model names, codes, counts and timings.
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
  // Every response carries a request id, including rejects before the gateway runs.
  let requestId = `req_${crypto.randomBytes(12).toString("hex")}`;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  res.setHeader("Access-Control-Expose-Headers", REQUEST_ID_HEADER);
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
    return json(res, 429, { error: { message: "Rate limit exceeded", type: "rate_limit_error", code: "rate_limited" } });
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
    return json(res, 429, { error: { message: "Rate limit exceeded", type: "rate_limit_error", code: "rate_limited" } });
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
    ctx = await gw.handleChatCompletions(body, auth, {
      abort_signal: abort.signal,
      request_id: requestId,
    });
  } catch (err) {
    console.error("[cp] gateway_error", requestId, err?.code || "gateway_error");
    logRequest({ request_id: requestId, status: 500, key_id: keyId, ms: Date.now() - t0, err: "gateway_error" });
    return openAiError(res, 500, "Internal gateway error", { code: "gateway_error", request_id: requestId });
  }
  // An idempotent replay answers with the original request's id.
  if (ctx.request_id && ctx.request_id !== requestId) {
    requestId = ctx.request_id;
    res.setHeader(REQUEST_ID_HEADER, requestId);
  }

  const logBase = {
    request_id: requestId,
    org: orgId,
    key_id: keyId,
    model_requested: body.model,
    model_routed: ctx.model_routed,
    provider: ctx.provider_name,
    stream: body.stream === true,
    tokens_saved: ctx.obs?.compression?.tokens_saved,
  };
  const obsLog = () => ({
    route_mode: ctx.obs?.routing?.mode,
    tier: ctx.obs?.routing?.classifier?.tier,
    ttft_ms: ctx.obs?.provider?.ttft_ms,
    provider_ms: ctx.obs?.provider?.latency_ms,
    in_tok: ctx.obs?.provider?.input_tokens,
    out_tok: ctx.obs?.provider?.output_tokens,
    retries: ctx.obs?.provider?.retries,
    saved_routing_usd: ctx.obs?.cost?.saved_routing_usd,
    saved_compression_usd: ctx.obs?.cost?.saved_compression_usd,
  });

  if (ctx.aborted) {
    const status = statusFor(ctx.error);
    const code = errorCode(ctx.error);
    logRequest({ ...logBase, ...obsLog(), status, err: code, ms: Date.now() - t0 });
    if (status >= 500) console.error("[cp] request failed", requestId, code);
    return openAiError(res, status, ctx.error?.message || "request_aborted", {
      code,
      request_id: requestId,
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
        ...obsLog(),
        status: ctx.aborted ? ctx.obs?.error?.http_status || statusFor(ctx.error) : 200,
        usd: ctx.actual_usd,
        err: ctx.aborted ? errorCode(ctx.error) : undefined,
        ms: Date.now() - t0,
      });
    }
    return;
  }

  logRequest({ ...logBase, ...obsLog(), status: 200, usd: ctx.actual_usd, ms: Date.now() - t0 });
  // Non-stream: finalize already ran inside the pipeline.
  return json(res, 200, ctx.openai || { error: { message: "empty_response" } });
};

module.exports.statusFor = statusFor;
module.exports.REQUEST_ID_HEADER = REQUEST_ID_HEADER;
module.exports.CHAT_MAX_BODY_BYTES = CHAT_MAX_BODY_BYTES;
