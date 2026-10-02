/**
 * POST /api/v1/chat/completions  (also /v1/chat/completions)
 *
 * UNADVERTISED control-plane gateway. Returns 404 unless SC_CP_GATEWAY=1.
 * OpenAI-compatible shape. Server-side provider keys only.
 * Never compresses the user ask (gateway compress stage).
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

  const keyId = owner.keyId || owner.key_id || "unknown";
  const keyRl = checkRateLimit(`cpgw:key:${keyId}`, RPM);
  if (!keyRl.allowed) {
    return json(res, 429, { error: { message: "Rate limit exceeded", type: "rate_limit_error" } });
  }

  let body;
  try {
    body = await readBody(req);
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

  const gw = getProcessGateway({});
  const auth = {
    org_id: owner.orgId || owner.uid || owner.owner_uid,
    key_id: keyId,
    agent_id: body.user || body.metadata?.agent_id,
  };

  let ctx;
  try {
    ctx = await gw.handleChatCompletions(body, auth);
  } catch (err) {
    return json(res, 500, {
      error: { message: err.message || "gateway_error", type: "server_error" },
    });
  }

  if (ctx.aborted) {
    const status =
      ctx.error?.message === "auth_required"
        ? 401
        : ctx.error?.class === "rejected"
          ? 402
          : ctx.error?.status && ctx.error.status >= 400 && ctx.error.status < 600
            ? ctx.error.status
            : 502;
    return json(res, status, {
      error: {
        message: ctx.error?.message || "request_aborted",
        type: ctx.error?.class || "gateway_error",
      },
      sc_request_id: ctx.request_id,
      sc_compression_trace: ctx.compression,
    });
  }

  if (body.stream === true) {
    try {
      await writeOpenAiSse(res, ctx);
    } finally {
      if (typeof gw.finalizeDeferred === "function") {
        await gw.finalizeDeferred(ctx).catch(() => {});
      }
    }
    return;
  }

  // Non-stream: finalize already ran inside the pipeline.
  return json(res, 200, ctx.openai || { error: { message: "empty_response" } });
};
