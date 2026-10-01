/**
 * Hosted MCP (Streamable HTTP) — Grok Bot / Cursor cloud agents.
 * Stateless JSON-RPC over POST. Auth: Authorization Bearer sc_… or X-API-Key.
 */
const crypto = require("crypto");

const SITE = "https://www.supercompress.dev";
const COMPRESS_URL = `${SITE}/api/v1/compress`;
const USAGE_URL = `${SITE}/api/usage`;
const ME_URL = `${SITE}/api/account?op=me`;
const CONNECT_BASE = `${SITE}/dashboard?source=grok-bot&connect=`;
const PROTOCOL_VERSION = "2025-03-26";
const SERVER_NAME = "supercompress";
const SERVER_VERSION = "0.5.29";

const TOOLS = [
  {
    name: "connect_account",
    description:
      "Connect SuperCompress. Preferred: the MCP host completes OAuth (browser Google sign-in) automatically. Fallback: open the dashboard link, copy an sc_ API key into Configure, then retry compress_context.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "compress_context",
    description:
      "Compress bulky context (tool dumps, logs, diffs, files) guided by the user's query. Never pass the query as context — only the dump. Returns a shorter digest that keeps answer-critical evidence.",
    inputSchema: {
      type: "object",
      properties: {
        context: {
          type: "string",
          description: "Bulky context to compress (not the user's ask)",
        },
        query: {
          type: "string",
          description: "The user's ask / task (never compressed; guides what to keep)",
        },
        session_id: {
          type: "string",
          description: "Optional session id for attribution (defaults to grok-bot)",
        },
      },
      required: ["context", "query"],
    },
  },
  {
    name: "usage_summary",
    description: "Fetch token savings and quota for the connected SuperCompress account.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function toolText(message) {
  return { content: [{ type: "text", text: String(message) }] };
}

function toolError(message) {
  return { isError: true, content: [{ type: "text", text: String(message) }] };
}

function extractApiKey(req) {
  const headerKey = String(req.headers["x-api-key"] || "").trim();
  if (headerKey.startsWith("sc_")) return headerKey;
  const auth = String(req.headers.authorization || "").trim();
  if (/^bearer\s+/i.test(auth)) {
    const token = auth.replace(/^bearer\s+/i, "").trim();
    if (token.startsWith("sc_")) return token;
  }
  // Optional path for chat install: /api/mcp?key=sc_…
  try {
    const url = new URL(req.url || "/", "https://www.supercompress.dev");
    const q = String(url.searchParams.get("key") || "").trim();
    if (q.startsWith("sc_")) return q;
  } catch {
    /* ignore */
  }
  return "";
}

async function httpJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || 120000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

async function handleToolCall(name, args, apiKey) {
  if (!["compress_context", "connect_account", "usage_summary"].includes(name)) {
    return toolError(`Unknown tool: ${name}`);
  }

  if (name === "connect_account") {
    if (apiKey) {
      try {
        const { response, body } = await httpJson(ME_URL, {
          method: "GET",
          headers: { "X-API-Key": apiKey },
          timeoutMs: 15_000,
        });
        if (response.ok) {
          return toolText(
            `SuperCompress account already connected${body?.email ? ` (${body.email})` : ""}. Ready to compress.`
          );
        }
      } catch {
        /* fall through */
      }
    }
    const code = crypto.randomBytes(16).toString("hex");
    const url = `${CONNECT_BASE}${code}`;
    return toolText(
      [
        "SuperCompress uses OAuth for remote MCP — your host should open a browser sign-in automatically.",
        "If it did not, open this link, sign in, and copy an API key:",
        url,
        "",
        "Then set Authorization: Bearer sc_… on https://www.supercompress.dev/api/mcp",
        "(or SUPERCOMPRESS_API_KEY on the plugin Configure screen) and call compress_context again.",
      ].join("\n")
    );
  }

  if (name === "usage_summary") {
    if (!apiKey) {
      return toolError("Not connected. Complete OAuth sign-in, or call connect_account and set your sc_ API key.");
    }
    try {
      const { response, body } = await httpJson(USAGE_URL, {
        method: "GET",
        headers: { "X-API-Key": apiKey },
        timeoutMs: 30_000,
      });
      if (!response.ok) {
        return toolError(body.detail || `Usage summary failed (${response.status})`);
      }
      return toolText(
        JSON.stringify({
          owner_uid: body.owner_uid,
          total_requests: body.total_requests,
          total_tokens_in: body.total_tokens_in,
          total_tokens_out: body.total_tokens_out,
          total_tokens_saved: body.total_tokens_saved,
          tokens_used_this_period: body.tokens_used_this_period,
          free_tokens_remaining: body.free_tokens_remaining,
          meter: body.meter || null,
          account_usage: body.account_usage || null,
          coding_agent_usage: body.coding_agent_usage,
        })
      );
    } catch (err) {
      return toolError(`Usage summary failed: ${err.message}`);
    }
  }

  const context = String(args.context || "");
  const query = String(args.query || "");
  const sessionId = String(args.session_id || "grok-bot").trim() || "grok-bot";
  if (!context.trim()) return toolError("context is required");
  if (!query.trim()) return toolError("query is required (the user's ask — never compressed)");
  if (!apiKey) {
    return toolError(
      "Not connected. Complete OAuth (browser sign-in) or call connect_account and set Authorization: Bearer sc_…, then retry."
    );
  }

  try {
    const { response, body } = await httpJson(COMPRESS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
        "X-SuperCompress-Agent": "Grok Bot",
        "Idempotency-Key": `mcp_${crypto.randomBytes(12).toString("hex")}`,
      },
      body: JSON.stringify({
        context,
        query,
        coding_agent: "Grok Bot",
        source: "grok-bot-mcp",
        session_id: sessionId,
      }),
      timeoutMs: 120_000,
    });
    if (response.status === 402 || body.paywall) {
      return toolError(
        body.detail ||
          body.notice ||
          "PAYWALL: Free quota used. Add credits at https://www.supercompress.dev/dashboard#billing"
      );
    }
    if (!response.ok) {
      return toolError(body.detail || body.message || `Compression failed (${response.status})`);
    }
    const compressed =
      body.compressed_context || body.compressed_text || body.compressed || body.text || "";
    if (!compressed) return toolError("Compression returned an empty digest.");
    const original = Number(body.original_tokens || body.tokens_in || 0);
    const kept = Number(body.compressed_tokens || body.kept_tokens || body.tokens_out || 0);
    const saved = Math.max(0, original - kept);
    const pct =
      body.savings_pct != null
        ? body.savings_pct
        : original > 0
          ? Math.round((saved / original) * 100)
          : 0;
    return toolText(
      JSON.stringify({
        compressed_context: compressed,
        compressed_text: compressed,
        original_tokens: original,
        compressed_tokens: kept,
        kept_tokens: kept,
        tokens_saved: saved,
        savings_pct: pct,
        tokens_saved_pct: pct,
        session_id: sessionId,
        source: "grok-bot-mcp",
      })
    );
  } catch (err) {
    const msg =
      err?.name === "AbortError"
        ? "Compression timed out. Try a smaller context chunk."
        : `SuperCompress error: ${err.message}`;
    return toolError(msg);
  }
}

async function dispatchRpc(msg, apiKey) {
  if (!msg || typeof msg !== "object") return null;
  const { id, method, params } = msg;

  // Notifications — no response body
  if (id === undefined || id === null) {
    return null;
  }

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Compress bulky context with compress_context(context, query). Never compress the user's ask. Prefer OAuth sign-in; call connect_account if the host has no token yet.",
      },
    };
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }

  if (method === "tools/call") {
    const name = String(params?.name || "");
    const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
    const result = await handleToolCall(name, args, apiKey);
    return { jsonrpc: "2.0", id, result };
  }

  if (method === "resources/list") {
    return { jsonrpc: "2.0", id, result: { resources: [] } };
  }

  if (method === "prompts/list") {
    return { jsonrpc: "2.0", id, result: { prompts: [] } };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

module.exports = {
  TOOLS,
  PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  extractApiKey,
  dispatchRpc,
  handleToolCall,
};
