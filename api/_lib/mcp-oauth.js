/**
 * MCP / CLI OAuth 2.1 helpers — PKCE (S256), Dynamic Client Registration,
 * authorization codes, and access tokens that are real sc_live_ API keys
 * (so /compress and hosted MCP keep working unchanged).
 *
 * Storage: Firestore in production; in-memory when SC_OAUTH_MEMORY=1 (unit tests).
 */
const crypto = require("crypto");

const SITE = "https://www.supercompress.dev";
const ISSUER = SITE;
const MCP_RESOURCE = `${SITE}/api/mcp`;
const AUTHORIZE_PATH = "/api/oauth/authorize";
const TOKEN_PATH = "/api/oauth/token";
const REGISTER_PATH = "/api/oauth/register";
const REVOKE_PATH = "/api/oauth/revoke";

const CODE_TTL_MS = 10 * 60 * 1000;
const CLIENT_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const ACCESS_TTL_SEC = 365 * 24 * 60 * 60; // access_token is an sc_ key; long-lived
const REFRESH_TTL_MS = 400 * 24 * 60 * 60 * 1000;

const mem = {
  clients: new Map(),
  codes: new Map(),
  refresh: new Map(),
};

function useMemory() {
  // Unit tests only. Production always uses Firestore (same as device-link secrets).
  return process.env.SC_OAUTH_MEMORY === "1";
}

function db() {
  const admin = require("firebase-admin");
  const { initFirebaseAdmin } = require("./auth");
  if (!initFirebaseAdmin()) {
    const err = new Error("OAuth requires Firebase Admin");
    err.status = 503;
    err.code = "oauth_unavailable";
    throw err;
  }
  return admin.firestore();
}

function issuerMetadata() {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${SITE}${AUTHORIZE_PATH}`,
    token_endpoint: `${SITE}${TOKEN_PATH}`,
    registration_endpoint: `${SITE}${REGISTER_PATH}`,
    revocation_endpoint: `${SITE}${REVOKE_PATH}`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp", "compress"],
    service_documentation: `${SITE}/docs/coding-agents`,
    client_id_metadata_document_supported: false,
  };
}

function protectedResourceMetadata() {
  return {
    resource: MCP_RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: ["mcp", "compress"],
    bearer_methods_supported: ["header"],
    resource_documentation: `${SITE}/docs/coding-agents`,
  };
}

function wwwAuthenticateHeader() {
  const meta = `${SITE}/.well-known/oauth-protected-resource`;
  // Build param name in pieces — some editors redact the literal "resource_metadata=".
  const prm = ["resource", "metadata"].join("_");
  return `Bearer realm="SuperCompress", ${prm}="${meta}", scope="mcp"`;
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sha256b64url(str) {
  return b64url(crypto.createHash("sha256").update(String(str), "utf8").digest());
}

function randomToken(bytes = 32) {
  return b64url(crypto.randomBytes(bytes));
}

function normalizeRedirectUri(uri) {
  const u = String(uri || "").trim();
  if (!u) return "";
  try {
    const parsed = new URL(u);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    // Localhost / loopback allowed for native MCP clients (Cursor, Claude, Inspector).
    if (parsed.protocol === "http:") {
      const host = parsed.hostname.toLowerCase();
      if (!(host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1")) {
        return "";
      }
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

function assertRedirectAllowed(uri, registered = []) {
  const normalized = normalizeRedirectUri(uri);
  if (!normalized) {
    const err = new Error("invalid_redirect_uri");
    err.status = 400;
    err.code = "invalid_redirect_uri";
    throw err;
  }
  if (Array.isArray(registered) && registered.length) {
    const ok = registered.some((r) => normalizeRedirectUri(r) === normalized);
    if (!ok) {
      const err = new Error("redirect_uri not registered for this client");
      err.status = 400;
      err.code = "invalid_redirect_uri";
      throw err;
    }
  }
  return normalized;
}

function validateResource(resource) {
  if (!resource) return MCP_RESOURCE;
  const r = String(resource).trim().replace(/\/$/, "");
  const allowed = [MCP_RESOURCE, `${SITE}/mcp`, SITE];
  if (!allowed.includes(r) && !r.startsWith(`${SITE}/api/mcp`)) {
    const err = new Error("invalid_resource");
    err.status = 400;
    err.code = "invalid_target";
    throw err;
  }
  return MCP_RESOURCE;
}

async function saveClient(client) {
  if (useMemory()) {
    mem.clients.set(client.client_id, client);
    return client;
  }
  await db().collection("oauth_clients").doc(client.client_id).set(client, { merge: true });
  return client;
}

async function getClient(clientId) {
  const id = String(clientId || "").trim();
  if (!id) return null;
  if (useMemory()) return mem.clients.get(id) || null;
  const snap = await db().collection("oauth_clients").doc(id).get();
  return snap.exists ? snap.data() : null;
}

/** Upsert a public client (DCR result or soft foreign client_id from MCP hosts). */
async function upsertClient({ clientId, redirectUris, clientName = "MCP client" }) {
  const id = String(clientId || "").trim();
  if (!id) {
    const err = new Error("client_id required");
    err.status = 400;
    throw err;
  }
  const uris = (Array.isArray(redirectUris) ? redirectUris : [])
    .map((u) => normalizeRedirectUri(u))
    .filter(Boolean);
  if (!uris.length) {
    const err = new Error("redirect_uris required");
    err.status = 400;
    throw err;
  }
  const existing = await getClient(id);
  const merged = Array.from(
    new Set([...(existing?.redirect_uris || []).map(normalizeRedirectUri).filter(Boolean), ...uris])
  );
  const now = new Date().toISOString();
  const client = {
    client_id: id,
    client_id_issued_at: existing?.client_id_issued_at || Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    redirect_uris: merged,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: String(clientName || existing?.client_name || "MCP client").trim().slice(0, 120),
    scope: "mcp compress",
    created_at: existing?.created_at || now,
    expires_at: new Date(Date.now() + CLIENT_TTL_MS).toISOString(),
  };
  return saveClient(client);
}

/**
 * RFC 7591 dynamic client registration (public clients, auth method none).
 */
async function registerClient(body = {}) {
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.map((u) => normalizeRedirectUri(u)).filter(Boolean)
    : [];
  if (!redirectUris.length) {
    const err = new Error("redirect_uris required");
    err.status = 400;
    err.code = "invalid_client_metadata";
    throw err;
  }
  for (const u of redirectUris) assertRedirectAllowed(u);

  const clientId = `sc_oauth_${randomToken(18)}`;
  const now = new Date().toISOString();
  const client = {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: String(body.client_name || "MCP client").trim().slice(0, 120) || "MCP client",
    client_uri: String(body.client_uri || "").trim().slice(0, 500) || null,
    scope: "mcp compress",
    created_at: now,
    expires_at: new Date(Date.now() + CLIENT_TTL_MS).toISOString(),
  };
  await saveClient(client);
  return {
    client_id: client.client_id,
    client_id_issued_at: client.client_id_issued_at,
    client_secret_expires_at: 0,
    redirect_uris: client.redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: client.grant_types,
    response_types: client.response_types,
    client_name: client.client_name,
  };
}

async function saveCode(record) {
  if (useMemory()) {
    mem.codes.set(record.code, record);
    return;
  }
  await db().collection("oauth_auth_codes").doc(record.code).set(record);
}

async function takeCode(code) {
  const id = String(code || "").trim();
  if (!id) return null;
  if (useMemory()) {
    const rec = mem.codes.get(id);
    if (!rec) return null;
    mem.codes.delete(id);
    return rec;
  }
  const ref = db().collection("oauth_auth_codes").doc(id);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data();
    tx.delete(ref);
    return data;
  });
}

async function saveRefresh(record) {
  if (useMemory()) {
    mem.refresh.set(record.refresh_token, record);
    return;
  }
  await db().collection("oauth_refresh").doc(record.refresh_token).set(record);
}

async function getRefresh(token) {
  const id = String(token || "").trim();
  if (!id) return null;
  if (useMemory()) return mem.refresh.get(id) || null;
  const snap = await db().collection("oauth_refresh").doc(id).get();
  return snap.exists ? snap.data() : null;
}

async function deleteRefresh(token) {
  const id = String(token || "").trim();
  if (!id) return;
  if (useMemory()) {
    mem.refresh.delete(id);
    return;
  }
  await db().collection("oauth_refresh").doc(id).delete().catch(() => {});
}

/**
 * After Google sign-in on the dashboard: mint a one-time auth code.
 */
async function approveAuthorization({
  ownerUid,
  clientId,
  redirectUri,
  codeChallenge,
  codeChallengeMethod = "S256",
  state = "",
  resource = MCP_RESOURCE,
  scope = "mcp",
  accessTokenSecret,
  keyId = null,
}) {
  if (!ownerUid) {
    const err = new Error("login_required");
    err.status = 401;
    throw err;
  }
  // Validate redirect shape before any client write.
  const redirectSolo = assertRedirectAllowed(redirectUri);
  let client = await getClient(clientId);
  if (!client) {
    client = await upsertClient({
      clientId,
      redirectUris: [redirectSolo],
      clientName: String(clientId).slice(0, 80) || "MCP client",
    });
  }
  const redirect = assertRedirectAllowed(redirectUri, client.redirect_uris);
  const method = String(codeChallengeMethod || "S256").toUpperCase();
  if (method !== "S256") {
    const err = new Error("code_challenge_method must be S256");
    err.status = 400;
    err.code = "invalid_request";
    throw err;
  }
  const challenge = String(codeChallenge || "").trim();
  if (challenge.length < 43 || challenge.length > 128) {
    const err = new Error("invalid code_challenge");
    err.status = 400;
    err.code = "invalid_request";
    throw err;
  }
  if (!accessTokenSecret || !String(accessTokenSecret).startsWith("sc_")) {
    const err = new Error("Could not mint MCP access credential");
    err.status = 500;
    throw err;
  }

  const code = `sc_ac_${randomToken(24)}`;
  const now = Date.now();
  await saveCode({
    code,
    client_id: String(clientId),
    owner_uid: ownerUid,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: validateResource(resource),
    scope: String(scope || "mcp").slice(0, 80),
    access_token: accessTokenSecret,
    key_id: keyId,
    state: String(state || "").slice(0, 256),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + CODE_TTL_MS).toISOString(),
  });

  const url = new URL(redirect);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", String(state));
  return { code, redirect_to: url.toString(), expires_in: Math.floor(CODE_TTL_MS / 1000) };
}

function verifyPkce(verifier, challenge) {
  const v = String(verifier || "");
  if (v.length < 43 || v.length > 128) return false;
  return sha256b64url(v) === String(challenge || "");
}

async function exchangeAuthorizationCode({
  code,
  redirectUri,
  codeVerifier,
  clientId,
}) {
  const rec = await takeCode(code);
  if (!rec) {
    const err = new Error("invalid_grant");
    err.status = 400;
    err.code = "invalid_grant";
    throw err;
  }
  if (new Date(rec.expires_at).getTime() < Date.now()) {
    const err = new Error("authorization code expired");
    err.status = 400;
    err.code = "invalid_grant";
    throw err;
  }
  if (String(rec.client_id) !== String(clientId || "")) {
    const err = new Error("client_id mismatch");
    err.status = 400;
    err.code = "invalid_grant";
    throw err;
  }
  if (normalizeRedirectUri(redirectUri) !== normalizeRedirectUri(rec.redirect_uri)) {
    const err = new Error("redirect_uri mismatch");
    err.status = 400;
    err.code = "invalid_grant";
    throw err;
  }
  if (!verifyPkce(codeVerifier, rec.code_challenge)) {
    const err = new Error("invalid code_verifier");
    err.status = 400;
    err.code = "invalid_grant";
    throw err;
  }

  const refreshToken = `sc_rt_${randomToken(24)}`;
  await saveRefresh({
    refresh_token: refreshToken,
    client_id: rec.client_id,
    owner_uid: rec.owner_uid,
    access_token: rec.access_token,
    key_id: rec.key_id,
    scope: rec.scope,
    resource: rec.resource,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + REFRESH_TTL_MS).toISOString(),
  });

  return {
    access_token: rec.access_token,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SEC,
    refresh_token: refreshToken,
    scope: rec.scope || "mcp",
  };
}

async function exchangeRefreshToken({ refreshToken, clientId }) {
  const rec = await getRefresh(refreshToken);
  if (!rec) {
    const err = new Error("invalid_grant");
    err.status = 400;
    err.code = "invalid_grant";
    throw err;
  }
  if (new Date(rec.expires_at).getTime() < Date.now()) {
    await deleteRefresh(refreshToken);
    const err = new Error("refresh_token expired");
    err.status = 400;
    err.code = "invalid_grant";
    throw err;
  }
  if (clientId && String(rec.client_id) !== String(clientId)) {
    const err = new Error("client_id mismatch");
    err.status = 400;
    err.code = "invalid_grant";
    throw err;
  }
  // Rotate refresh token
  await deleteRefresh(refreshToken);
  const nextRefresh = `sc_rt_${randomToken(24)}`;
  await saveRefresh({
    ...rec,
    refresh_token: nextRefresh,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + REFRESH_TTL_MS).toISOString(),
  });
  return {
    access_token: rec.access_token,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SEC,
    refresh_token: nextRefresh,
    scope: rec.scope || "mcp",
  };
}

function buildAuthorizeDashboardUrl(query = {}) {
  const u = new URL(`${SITE}/dashboard`);
  u.searchParams.set("oauth", "1");
  for (const key of [
    "client_id",
    "redirect_uri",
    "code_challenge",
    "code_challenge_method",
    "state",
    "resource",
    "scope",
    "response_type",
  ]) {
    if (query[key] != null && String(query[key]).length) {
      u.searchParams.set(key, String(query[key]));
    }
  }
  u.searchParams.set("source", "mcp-oauth");
  return u.toString();
}

function parseFormBody(req) {
  if (typeof req.body === "object" && req.body !== null && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  const raw = typeof req.body === "string" ? req.body : "";
  if (!raw) return {};
  if (raw.trim().startsWith("{")) {
    try {
      return JSON.parse(raw);
    } catch {
      /* fall through */
    }
  }
  const out = {};
  const params = new URLSearchParams(raw);
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

/** Reset memory stores (tests). */
function _resetMemoryForTests() {
  mem.clients.clear();
  mem.codes.clear();
  mem.refresh.clear();
}

module.exports = {
  SITE,
  ISSUER,
  MCP_RESOURCE,
  AUTHORIZE_PATH,
  TOKEN_PATH,
  REGISTER_PATH,
  issuerMetadata,
  protectedResourceMetadata,
  wwwAuthenticateHeader,
  registerClient,
  getClient,
  upsertClient,
  saveClient,
  approveAuthorization,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  buildAuthorizeDashboardUrl,
  assertRedirectAllowed,
  normalizeRedirectUri,
  validateResource,
  verifyPkce,
  sha256b64url,
  parseFormBody,
  deleteRefresh,
  _resetMemoryForTests,
};
