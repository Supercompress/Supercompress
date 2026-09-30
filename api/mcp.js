/**
 * POST/GET /api/mcp — Streamable HTTP MCP for Grok Bot + Cursor cloud agents.
 *
 * Auth: Authorization: Bearer sc_…  or  X-API-Key: sc_…
 * Chat install: "Add this MCP server: https://www.supercompress.dev/api/mcp"
 * (then Configure the API key, or pass Authorization header when the Bot asks).
 */
const { cors, securityHeaders } = require("./_lib/http");
const { dispatchRpc, extractApiKey, SERVER_NAME, SERVER_VERSION, PROTOCOL_VERSION } = require("./_lib/mcp-http");

const MAX_MCP_BODY_BYTES = 1_500_000; // ~1.5MB JSON-RPC envelope (context capped at 120k by compress)

function mcpCors(res) {
  cors(res);
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-API-Key, Idempotency-Key, X-Request-Id, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID"
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, MCP-Protocol-Version");
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

module.exports = async (req, res) => {
  mcpCors(res);
  securityHeaders(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  // Soft discovery for scanners / health pings
  if (req.method === "GET" || req.method === "HEAD") {
    const accept = String(req.headers.accept || "");
    if (accept.includes("text/event-stream")) {
      // Stateless server — no long-lived SSE stream without a prior session.
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
      auth: "Authorization: Bearer sc_… or X-API-Key",
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
    // Batch support (rare)
    if (Array.isArray(body)) {
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

    const rpc = await dispatchRpc(body, apiKey);
    if (!rpc) {
      // notification acknowledged
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
