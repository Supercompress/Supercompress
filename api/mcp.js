/**
 * POST/GET /api/mcp — Streamable HTTP MCP for Grok Bot + Cursor cloud agents.
 *
 * Auth:
 *   - OAuth 2.1 (PKCE) via /.well-known/oauth-*  → Bearer access_token (sc_live_…)
 *   - Or Authorization: Bearer sc_… / X-API-Key
 * Chat install: "Add this MCP server: https://www.supercompress.dev/api/mcp"
 */
const { cors, securityHeaders } = require("./_lib/http");
const {
  dispatchRpc,
  extractApiKey,
  rpcNeedsAuth,
  SERVER_NAME,
  SERVER_VERSION,
  PROTOCOL_VERSION,
} = require("./_lib/mcp-http");
const { wwwAuthenticateHeader, MCP_RESOURCE } = require("./_lib/mcp-oauth");

const MAX_MCP_BODY_BYTES = 1_500_000;

function mcpCors(res) {
  cors(res);
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-API-Key, Idempotency-Key, X-Request-Id, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID"
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, MCP-Protocol-Version, WWW-Authenticate");
}

function readMcpBody(req) {
  if (typeof req.body === "object" && req.body !== null) {
    const bytes = Buffer.byteLength(JSON.stringify(req.body), "utf8");
    if (bytes > MAX_MCP_BODY_BYTES) {
      const err = new Error(`Request body too large (max ${Math.floor(MAX_MCP_BODY_BYTES / 1000)}KB)`);
      err.status = 413;
      throw err;
    }
    return req.body;
  }
  if (typeof req.body === "string") {
    const bytes = Buffer.byteLength(req.body, "utf8");
    if (bytes > MAX_MCP_BODY_BYTES) {
      const err = new Error(`Request body too large (max ${Math.floor(MAX_MCP_BODY_BYTES / 1000)}KB)`);
      err.status = 413;
      throw err;
    }
    return req.body ? JSON.parse(req.body) : {};
  }
  return {};
}

function sendJson(res, status, body, extraHeaders = {}) {
  mcpCors(res);
  securityHeaders(res);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("MCP-Protocol-Version", PROTOCOL_VERSION);
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (v != null) res.setHeader(k, String(v));
  }
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function sendUnauthorized(res, id = null) {
  mcpCors(res);
  securityHeaders(res);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("WWW-Authenticate", wwwAuthenticateHeader());
  res.setHeader("MCP-Protocol-Version", PROTOCOL_VERSION);
  res.statusCode = 401;
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "Unauthorized. Complete OAuth (browser sign-in) or set Authorization: Bearer sc_…",
      },
      id,
    })
  );
}

module.exports = async (req, res) => {
  mcpCors(res);
  securityHeaders(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method === "GET" || req.method === "HEAD") {
    const accept = String(req.headers.accept || "");
    if (accept.includes("text/event-stream")) {
      return sendJson(res, 405, {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "SSE stream not required; POST JSON-RPC to this URL.",
        },
        id: null,
      });
    }
    return sendJson(res, 200, {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      transport: "streamable-http",
      protocolVersion: PROTOCOL_VERSION,
      resource: MCP_RESOURCE,
      auth: {
        oauth: true,
        protected_resource_metadata: "https://www.supercompress.dev/.well-known/oauth-protected-resource",
        authorization_server_metadata:
          "https://www.supercompress.dev/.well-known/oauth-authorization-server",
        api_key: "Authorization: Bearer sc_… or X-API-Key (optional if OAuth completed)",
      },
      tools: ["compress_context", "connect_account", "usage_summary"],
      docs: "https://www.supercompress.dev/docs/coding-agents",
      install: "Add this MCP server: https://www.supercompress.dev/api/mcp",
    });
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  }

  let body;
  try {
    body = readMcpBody(req);
  } catch (err) {
    return sendJson(res, err.status || 400, {
      jsonrpc: "2.0",
      error: { code: -32700, message: err.message || "Parse error" },
      id: null,
    });
  }

  const apiKey = extractApiKey(req);
  const sessionHeader = req.headers["mcp-session-id"];
  const sessionId =
    (sessionHeader && String(sessionHeader).trim()) ||
    `sc_${require("crypto").randomBytes(8).toString("hex")}`;

  try {
    if (Array.isArray(body)) {
      for (const msg of body) {
        if (rpcNeedsAuth(msg) && !apiKey) {
          return sendUnauthorized(res, msg?.id ?? null);
        }
      }
      const out = [];
      for (const msg of body) {
        const rpc = await dispatchRpc(msg, apiKey);
        if (rpc) out.push(rpc);
      }
      if (!out.length) {
        res.statusCode = 202;
        mcpCors(res);
        return res.end();
      }
      return sendJson(res, 200, out.length === 1 ? out[0] : out, {
        "Mcp-Session-Id": sessionId,
      });
    }

    if (rpcNeedsAuth(body) && !apiKey) {
      return sendUnauthorized(res, body?.id ?? null);
    }

    const rpc = await dispatchRpc(body, apiKey);
    if (!rpc) {
      res.statusCode = 202;
      mcpCors(res);
      res.setHeader("Mcp-Session-Id", sessionId);
      return res.end();
    }
    return sendJson(res, 200, rpc, { "Mcp-Session-Id": sessionId });
  } catch (err) {
    console.error("mcp error:", err && err.stack ? err.stack : err);
    return sendJson(res, 500, {
      jsonrpc: "2.0",
      error: { code: -32603, message: err.message || "Internal error" },
      id: body?.id ?? null,
    });
  }
};
