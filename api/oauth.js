/**
 * OAuth 2.1 endpoints for MCP (+ shared with CLI device-link UX).
 *
 * Routes (via vercel.json rewrites):
 *   GET  /.well-known/oauth-authorization-server
 *   GET  /.well-known/oauth-protected-resource
 *   GET  /.well-known/oauth-protected-resource/api/mcp
 *   GET  /api/oauth/authorize
 *   POST /api/oauth/token
 *   POST /api/oauth/register
 *   POST /api/oauth/revoke
 *   POST /api/oauth/approve   (dashboard, Firebase ID token)
 */
const { cors, securityHeaders, readBody, checkRateLimit, clientIp } = require("./_lib/http");
const { verifyUser } = require("./_lib/auth");
const { KEY_PREFIX } = require("./_lib/keys");
const {
  issuerMetadata,
  protectedResourceMetadata,
  registerClient,
  approveAuthorization,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  buildAuthorizeDashboardUrl,
  assertRedirectAllowed,
  validateResource,
  parseFormBody,
  deleteRefresh,
  upsertClient,
  MCP_RESOURCE,
} = require("./_lib/mcp-oauth");

function send(res, status, body, extra = {}) {
  cors(res);
  securityHeaders(res);
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && k !== "Content-Type") res.setHeader(k, String(v));
  }
  res.setHeader("Content-Type", extra["Content-Type"] || "application/json");
  res.statusCode = status;
  if (body === null || body === undefined) return res.end();
  if (typeof body === "string") return res.end(body);
  return res.end(JSON.stringify(body));
}

function oauthError(res, status, code, description) {
  return send(res, status, {
    error: code,
    error_description: description || code,
    detail: description || code,
  });
}

function opFromReq(req) {
  const q = String(req.query?.op || "").trim();
  if (q) return q;
  try {
    const u = new URL(req.url || "/", "https://www.supercompress.dev");
    const parts = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts[0] === ".well-known") {
      if (parts[1] === "oauth-authorization-server") return "metadata-as";
      if (parts[1] === "oauth-protected-resource") return "metadata-pr";
    }
    if (parts[0] === "api" && parts[1] === "oauth") {
      return parts[2] || "metadata-as";
    }
  } catch {
    /* ignore */
  }
  return "metadata-as";
}

async function mintMcpKey(ownerUid) {
  const admin = require("firebase-admin");
  const { getPlan } = require("./_lib/stripe");
  const { createAuthPluginKey, revokeAuthPluginKey, listAuthPluginKeys } = require("./_lib/auth-connect");
  const owner = await admin.auth().getUser(ownerUid).catch(() => ({ uid: ownerUid, customClaims: {} }));
  const plan = getPlan(owner.customClaims?.sc_plan || "free");
  const maxKeys = plan.max_keys || 10;
  try {
    return await createAuthPluginKey(ownerUid, "MCP OAuth", { maxKeys });
  } catch (err) {
    if (err.status !== 429) throw err;
    const existing = await listAuthPluginKeys(ownerUid).catch(() => []);
    const pool = existing
      .filter((k) => /mcp|coding agent|cli|oauth/i.test(String(k.name || "")))
      .slice()
      .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    for (const victim of pool.slice(0, 2)) {
      try {
        await revokeAuthPluginKey(ownerUid, victim.id);
      } catch {
        /* continue */
      }
    }
    return createAuthPluginKey(ownerUid, "MCP OAuth", { maxKeys });
  }
}

async function handleAuthorizeGet(req, res) {
  const q = req.query || {};
  const responseType = String(q.response_type || "code").trim() || "code";
  const clientId = String(q.client_id || "").trim();
  const redirectUri = String(q.redirect_uri || "").trim();
  const challenge = String(q.code_challenge || "").trim();
  const method = String(q.code_challenge_method || "S256").trim() || "S256";
  const state = String(q.state || "");
  const resource = String(q.resource || MCP_RESOURCE);
  const scope = String(q.scope || "mcp");

  if (responseType !== "code") {
    return oauthError(res, 400, "unsupported_response_type", "Only response_type=code is supported");
  }
  if (!clientId) return oauthError(res, 400, "invalid_request", "client_id required");
  if (!redirectUri) return oauthError(res, 400, "invalid_request", "redirect_uri required");
  if (!challenge) return oauthError(res, 400, "invalid_request", "code_challenge required (PKCE S256)");
  if (String(method).toUpperCase() !== "S256") {
    return oauthError(res, 400, "invalid_request", "code_challenge_method must be S256");
  }
  try {
    const normalized = assertRedirectAllowed(redirectUri);
    validateResource(resource);
    await upsertClient({
      clientId,
      redirectUris: [normalized],
      clientName: clientId.slice(0, 80) || "MCP client",
    });
  } catch (err) {
    return oauthError(res, err.status || 400, err.code || "invalid_request", err.message);
  }

  const dash = buildAuthorizeDashboardUrl({
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource,
    scope,
    response_type: "code",
  });
  cors(res);
  securityHeaders(res);
  res.statusCode = 302;
  res.setHeader("Location", dash);
  res.setHeader("Cache-Control", "no-store");
  return res.end();
}

async function handleApprove(req, res) {
  if (req.method !== "POST") return oauthError(res, 405, "invalid_request", "POST only");
  const ip = clientIp(req);
  const rl = checkRateLimit(`oauth:approve:${ip}`, 30);
  if (!rl.allowed) return oauthError(res, 429, "slow_down", "Too many approve attempts");

  let user;
  try {
    user = await verifyUser(req);
  } catch (err) {
    return oauthError(res, err.status || 401, "login_required", err.message || "Sign in required");
  }

  const body = readBody(req) || {};
  const clientId = String(body.client_id || "").trim();
  const redirectUri = String(body.redirect_uri || "").trim();
  const challenge = String(body.code_challenge || "").trim();
  const method = String(body.code_challenge_method || "S256").trim();
  const state = String(body.state || "");
  const resource = String(body.resource || MCP_RESOURCE);
  const scope = String(body.scope || "mcp");

  try {
    const key = await mintMcpKey(user.uid);
    const secret = key.secret || key.full_key || null;
    if (!secret || !String(secret).startsWith("sc_")) {
      return oauthError(res, 500, "server_error", "Could not create MCP credential");
    }
    if (!String(secret).startsWith(KEY_PREFIX) && !String(secret).startsWith("sc_")) {
      return oauthError(res, 500, "server_error", "Could not create MCP credential");
    }

    const result = await approveAuthorization({
      ownerUid: user.uid,
      clientId,
      redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: method,
      state,
      resource,
      scope,
      accessTokenSecret: secret,
      keyId: key.key?.id || key.uid || key.id || null,
    });
    return send(res, 200, {
      ok: true,
      redirect_to: result.redirect_to,
      expires_in: result.expires_in,
    });
  } catch (err) {
    return oauthError(res, err.status || 400, err.code || "invalid_request", err.message);
  }
}

async function handleToken(req, res) {
  if (req.method !== "POST") return oauthError(res, 405, "invalid_request", "POST only");
  const ip = clientIp(req);
  const rl = checkRateLimit(`oauth:token:${ip}`, 60);
  if (!rl.allowed) return oauthError(res, 429, "slow_down", "Too many token requests");

  const body = parseFormBody(req);
  const grant = String(body.grant_type || "").trim();
  try {
    if (grant === "authorization_code") {
      const out = await exchangeAuthorizationCode({
        code: body.code,
        redirectUri: body.redirect_uri,
        codeVerifier: body.code_verifier,
        clientId: body.client_id,
      });
      return send(res, 200, out, { "Cache-Control": "no-store" });
    }
    if (grant === "refresh_token") {
      const out = await exchangeRefreshToken({
        refreshToken: body.refresh_token,
        clientId: body.client_id,
      });
      return send(res, 200, out, { "Cache-Control": "no-store" });
    }
    return oauthError(res, 400, "unsupported_grant_type", "Use authorization_code or refresh_token");
  } catch (err) {
    return oauthError(res, err.status || 400, err.code || "invalid_grant", err.message);
  }
}

async function handleRegister(req, res) {
  if (req.method !== "POST") return oauthError(res, 405, "invalid_request", "POST only");
  const ip = clientIp(req);
  const rl = checkRateLimit(`oauth:register:${ip}`, 20);
  if (!rl.allowed) return oauthError(res, 429, "slow_down", "Too many registrations");
  try {
    const body = typeof req.body === "object" && req.body ? req.body : parseFormBody(req);
    const out = await registerClient(body);
    return send(res, 201, out, { "Cache-Control": "no-store" });
  } catch (err) {
    return oauthError(res, err.status || 400, err.code || "invalid_client_metadata", err.message);
  }
}

async function handleRevoke(req, res) {
  if (req.method !== "POST") return oauthError(res, 405, "invalid_request", "POST only");
  const body = parseFormBody(req);
  const token = String(body.token || body.refresh_token || "").trim();
  if (token.startsWith("sc_rt_")) {
    await deleteRefresh(token).catch(() => {});
  }
  return send(res, 200, { revoked: true });
}

module.exports = async (req, res) => {
  cors(res);
  securityHeaders(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  const op = opFromReq(req);

  if (op === "metadata-as" || op === "authorization-server") {
    return send(res, 200, issuerMetadata(), { "Cache-Control": "public, max-age=3600" });
  }
  if (op === "metadata-pr" || op === "protected-resource") {
    return send(res, 200, protectedResourceMetadata(), { "Cache-Control": "public, max-age=3600" });
  }
  if (op === "authorize") {
    if (req.method === "GET" || req.method === "HEAD") return handleAuthorizeGet(req, res);
    return oauthError(res, 405, "invalid_request", "Authorize is GET → dashboard consent");
  }
  if (op === "approve") return handleApprove(req, res);
  if (op === "token") return handleToken(req, res);
  if (op === "register") return handleRegister(req, res);
  if (op === "revoke") return handleRevoke(req, res);

  return oauthError(res, 404, "not_found", `Unknown oauth op: ${op}`);
};
