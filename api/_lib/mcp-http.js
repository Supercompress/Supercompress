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
const SERVER_VERSION = "0.5.30";

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
      "Compress bulky context (tool dumps, logs, diffs, files, pages). Pass only the dump as `context`, never the user's ask. With a `query`, keeps the evidence that answers it (smallest digest). Without one, dump mode keeps about half the input. Read any `warning` field before trusting the digest; a `passthrough` result means keep using your original text.",
    inputSchema: {
      type: "object",
      properties: {
        context: {
          type: "string",
          description: "Bulky context to compress (not the user's ask)",
        },
        query: {
          type: "string",
          description:
            "Optional. The user's ask, verbatim (never compressed; guides what to keep). Omit to shrink a raw dump with no question.",
        },
        session_id: {
          type: "string",
          description: "Optional session id for attribution (defaults to grok-bot)",
        },
      },
      required: ["context"],
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
  // Do not accept ?key= — keys in URLs leak via logs, Referer, and shared links.
  return "";
}

/** Methods that must 401 (with WWW-Authenticate) so hosts prompt OAuth on connect. */
function rpcNeedsAuth(msg) {
  if (!msg || typeof msg !== "object") return false;
  const method = String(msg.method || "");
  if (method === "initialize") return true;
  if (method === "tools/call") {
    const name = String(msg.params?.name || "");
    return name !== "connect_account";
  }
  return false;
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
          ...(body.free_tokens_remaining === 0
            ? {
                quota_warning:
                  "Free monthly quota is used up. Requests now bill credits or pay-as-you-go, or stop with a paywall if neither is set up: https://www.supercompress.dev/dashboard#billing",
              }
            : {}),
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
        ...(query.trim() ? { query } : {}),
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
    return toolText(JSON.stringify(mcpCompressPayload(body, sessionId)));
  } catch (err) {
    const msg =
      err?.name === "AbortError"
        ? "Compression timed out. Try a smaller context chunk."
        : `SuperCompress error: ${err.message}`;
    return toolError(msg);
  }
}

/**
 * One copy of the digest, warnings first. A passthrough is not echoed: the agent already
 * holds the original, and echoing it doubled small results.
 */
function mcpCompressPayload(body, sessionId) {
  const original = Number(body.original_tokens || body.tokens_in || 0);
  const quotaWarning = body.quota_warning || body.quota?.warning || null;
  if (body.passthrough) {
    return {
      passthrough: true,
      notice: "Nothing to gain; keep using your original text. Not billed.",
      ...(quotaWarning ? { quota_warning: quotaWarning } : {}),
      session_id: sessionId,
    };
  }
  const compressed = body.compressed_context || body.compressed_text || body.compressed || body.text || "";
  const kept = Number(body.compressed_tokens || body.kept_tokens || body.tokens_out || 0);
  const saved = Math.max(0, original - kept);
  const pct = body.tokens_saved_pct != null
    ? Math.round(body.tokens_saved_pct * 10) / 10
    : original > 0 ? Math.round((saved / original) * 1000) / 10 : 0;
  return {
    ...(body.compression_warning ? { warning: body.compression_warning } : {}),
    ...(quotaWarning ? { quota_warning: quotaWarning } : {}),
    ...(body.notice ? { notice: body.notice } : {}),
    mode: body.query_mode || "query",
    original_tokens: original,
    compressed_tokens: kept,
    tokens_saved: saved,
    savings_pct: pct,
    compressed_context: compressed,
    session_id: sessionId,
  };
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
          "Compress bulky context with compress_context(context, query?). Never compress the user's ask. Read `warning` and `quota_warning` fields when present. Prefer OAuth sign-in; call connect_account if the host has no token yet.",
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
  rpcNeedsAuth,
  dispatchRpc,
  handleToolCall,
  mcpCompressPayload,
};
