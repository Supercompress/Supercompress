#!/usr/bin/env node
/**
 * SuperCompress MCP server (stdio) — zero heavy deps.
 *
 * Uses MCP JSON-RPC over stdio with Content-Length framing (and newline JSON
 * as a fallback). Avoids @modelcontextprotocol/sdk so `npm install -g` stays
 * fast and does not hang on a 100-package dependency tree.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const VERSION = require("../package.json").version;
const CONFIG_DIR = process.env.SUPERCOMPRESS_CONFIG_DIR || path.join(os.homedir(), ".supercompress");

const API_URL = "https://www.supercompress.dev/api/v1/compress";
const USAGE_URL = "https://www.supercompress.dev/api/usage";
const CONNECT_URL = "https://www.supercompress.dev/dashboard?source=mcp&connect=";
const PROTOCOL_VERSION = "2024-11-05";

function log(...args) {
  console.error("[supercompress-mcp]", ...args);
}

process.on("uncaughtException", (err) => {
  log("uncaughtException:", err && err.stack ? err.stack : err);
});
process.on("unhandledRejection", (err) => {
  log("unhandledRejection:", err && err.stack ? err.stack : err);
});
process.stdin.on("error", (err) => {
  if (err && (err.code === "EPIPE" || err.code === "EOF")) return;
  log("stdin error:", err.message || err);
});
process.stdout.on("error", (err) => {
  if (err && err.code === "EPIPE") return;
  log("stdout error:", err.message || err);
});

async function httpJson(url, options = {}) {
  if (typeof fetch !== "function") {
    throw new Error("This MCP server needs Node.js 18+ (global fetch). Upgrade Node, then restart your agent.");
  }
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

function loadApiKey() {
  let apiKey = "";
  const envKey = (process.env.SUPERCOMPRESS_API_KEY || "").trim();
  if (envKey && !envKey.includes("${") && envKey.startsWith("sc_")) {
    apiKey = envKey;
  }
  if (!apiKey) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "config.json"), "utf8"));
      apiKey = String(config.api_key || "").trim();
    } catch {}
  }
  return apiKey;
}

function toolError(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function toolText(message) {
  return { content: [{ type: "text", text: message }] };
}

const TOOLS = [
  {
    name: "connect_account",
    description:
      "Connect this MCP installation to a SuperCompress account. Opens the dashboard so the user can sign in and link this install with a one-time code.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "compress_context",
    description:
      "Compress *new* coding context into rolling session memory (Headroom-parity). Already-seen chunks are skipped; when memory grows large it is compacted. Pass only the new dump — not the whole history. Preserve code and facts relevant to the query.",
    inputSchema: {
      type: "object",
      properties: {
        context: { type: "string", description: "New context to compress (not previously seen this session)" },
        query: { type: "string", description: "The coding task or question (never compressed)" },
        session_id: { type: "string", description: "Optional session id for rolling memory (defaults to mcp)" },
      },
      required: ["context", "query"],
    },
  },
  {
    name: "usage_summary",
    description: "Fetch per-coding-agent token savings tracked for the connected SuperCompress account.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

async function handleToolCall(name, args = {}) {
  if (!["compress_context", "connect_account", "usage_summary"].includes(name)) {
    return toolError(`Unknown tool: ${name}`);
  }

  let apiKey = loadApiKey();
  const context = String(args.context || "");
  const query = String(args.query || "");
  const sessionId =
    String(args.session_id || process.env.SUPERCOMPRESS_SESSION_ID || "mcp").trim() || "mcp";

  if (name === "connect_account") {
    // 128-bit pairing code (was 32-bit) — must match server normalizeCode length rules
    const code = require("crypto").randomBytes(16).toString("hex");
    const url = `${CONNECT_URL}${code}`;
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try {
      execFile(opener, [url]);
    } catch (err) {
      log("open browser failed:", err.message || err);
    }
    const started = Date.now();
    const maxWaitMs = 180_000;
    while (Date.now() - started < maxWaitMs) {
      try {
        const { response, body } = await httpJson(
          `https://www.supercompress.dev/api/connect-device?code=${encodeURIComponent(code)}`,
          { method: "GET", timeoutMs: 15_000 }
        );
        if (response.ok && body.status === "linked" && body.secret) {
          const configPath = path.join(CONFIG_DIR, "config.json");
          let config = {};
          try {
            config = JSON.parse(fs.readFileSync(configPath, "utf8"));
          } catch {}
          fs.mkdirSync(path.dirname(configPath), { recursive: true });
          fs.writeFileSync(
            configPath,
            JSON.stringify(
              { ...config, api_key: body.secret, connected_at: new Date().toISOString() },
              null,
              2
            )
          );
          return toolText("SuperCompress account connected. Future compression usage is metered to this account.");
        }
      } catch (err) {
        log("connect poll failed:", err.message || err);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return toolError(
      `Timed out waiting for browser sign-in. Open ${url} , finish linking, then call connect_account again (or run: supercompress connect).`
    );
  }

  if (name === "usage_summary") {
    if (!apiKey) return toolError("SuperCompress account is not connected. Call connect_account first.");
    try {
      const { response, body } = await httpJson(USAGE_URL, {
        method: "GET",
        headers: { "X-API-Key": apiKey },
        timeoutMs: 30_000,
      });
      if (!response.ok) {
        return toolError(body.detail || `Usage summary request failed (${response.status})`);
      }
      return toolText(
        JSON.stringify({
          owner_uid: body.owner_uid,
          total_requests: body.total_requests,
          total_tokens_in: body.total_tokens_in,
          total_tokens_out: body.total_tokens_out,
          total_tokens_saved: body.total_tokens_saved,
          coding_agent_usage: body.coding_agent_usage,
        })
      );
    } catch (err) {
      return toolError(`Usage summary failed: ${err.message}`);
    }
  }

  if (!context.trim()) return toolError("context is required");
  if (!apiKey) {
    return toolError(
      "SuperCompress account is not connected. Call connect_account, finish sign-in in the browser, then retry compress_context (or run: supercompress setup)."
    );
  }

  try {
    const { compressIncremental, writeInbox } = require("./cursor-hooks/compress-prompt-lib");
    const result = await compressIncremental({
      context,
      query,
      codingAgent: "mcp",
      sessionId,
      kind: "mcp",
    });
    if (result.skipped === "no_key") {
      return toolError(
        "SuperCompress account is not connected. Call connect_account, finish sign-in in the browser, then retry compress_context (or run: supercompress setup)."
      );
    }
    if (result.paywall || result.skipped === "paywall") {
      return toolError(
        result.notice ||
          result.detail ||
          "PAYWALL: Free 1M tokens used (or credits empty). Add credits at https://www.supercompress.dev/dashboard#billing"
      );
    }
    if (String(result.skipped || "").startsWith("http_")) {
      return toolError(
        result.detail
          ? `Compression failed (${result.skipped}): ${result.detail}`
          : `Compression failed (${result.skipped})`
      );
    }
    if (!result.compressed) {
      return toolError("Nothing new to compress (empty or already in session memory).");
    }
    const meta =
      result.skipped === "already_seen"
        ? `memory replay · session ${sessionId}`
        : `${result.original_tokens}→${result.compressed_tokens} (−${result.savings_pct}%)${
            result.compacted ? " · compacted" : " · delta-only"
          }`;
    writeInbox(query, result.compressed, meta, {
      kind: result.skipped === "already_seen" ? "session-memory" : "mcp",
      session_id: sessionId,
      compacted: Boolean(result.compacted),
    });
    return toolText(
      JSON.stringify({
        compressed_context: result.compressed,
        compressed_text: result.compressed,
        delta: result.delta || "",
        original_tokens: result.original_tokens,
        compressed_tokens: result.compressed_tokens,
        kept_tokens: result.compressed_tokens,
        tokens_saved: Math.max(0, (result.original_tokens || 0) - (result.compressed_tokens || 0)),
        savings_pct: result.savings_pct,
        tokens_saved_pct: result.savings_pct,
        session_id: sessionId,
        compacted: Boolean(result.compacted),
        skipped: result.skipped || null,
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

async function dispatch(msg) {
  if (!msg || typeof msg !== "object") return null;
  const { id, method, params } = msg;

  // Notifications — no response
  if (id === undefined || id === null) {
    return null;
  }

  try {
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "supercompress", version: VERSION },
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
      const name = params?.name;
      const args = params?.arguments || {};
      const result = await handleToolCall(name, args);
      return { jsonrpc: "2.0", id, result };
    }
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  } catch (err) {
    log("dispatch crash:", err && err.stack ? err.stack : err);
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: err.message || String(err) },
    };
  }
}

function writeMessage(obj) {
  const json = JSON.stringify(obj);
  const frame = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
  process.stdout.write(frame);
  // Also emit newline-delimited form for lightweight checkers / older clients
  // Only when SUPERCOMPRESS_MCP_NDJSON=1 to avoid double replies in production.
  if (process.env.SUPERCOMPRESS_MCP_NDJSON === "1") {
    process.stdout.write(json + "\n");
  }
}

function writeNdjson(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/** Prefer Content-Length; also accept newline-delimited JSON (mcp-check / tests). */
function createStdioReader(onMessage) {
  let buf = Buffer.alloc(0);
  let mode = null; // "cl" | "ndjson"

  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!mode) {
        const asStr = buf.toString("utf8", 0, Math.min(buf.length, 64));
        if (/Content-Length:/i.test(asStr)) {
          mode = "cl";
        } else if (buf.includes(0x0a) /* \n */) {
          mode = "ndjson";
        } else {
          break;
        }
      }

      if (mode === "cl") {
        const headerEnd = buf.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          // Some clients use \n\n
          const alt = buf.indexOf("\n\n");
          if (alt === -1) break;
          const header = buf.slice(0, alt).toString("utf8");
          const match = header.match(/Content-Length:\s*(\d+)/i);
          if (!match) {
            mode = "ndjson";
            continue;
          }
          const len = Number(match[1]);
          const start = alt + 2;
          if (buf.length < start + len) break;
          const body = buf.slice(start, start + len).toString("utf8");
          buf = buf.slice(start + len);
          try {
            onMessage(JSON.parse(body), "cl");
          } catch (err) {
            log("bad JSON frame:", err.message);
          }
          continue;
        }
        const header = buf.slice(0, headerEnd).toString("utf8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          mode = "ndjson";
          continue;
        }
        const len = Number(match[1]);
        const start = headerEnd + 4;
        if (buf.length < start + len) break;
        const body = buf.slice(start, start + len).toString("utf8");
        buf = buf.slice(start + len);
        try {
          onMessage(JSON.parse(body), "cl");
        } catch (err) {
          log("bad JSON frame:", err.message);
        }
        continue;
      }

      // ndjson
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      const line = buf.slice(0, nl).toString("utf8").trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line), "ndjson");
      } catch (err) {
        log("bad ndjson:", err.message);
      }
    }
  });
}

async function main() {
  let replyStyle = "cl"; // updated per inbound message
  createStdioReader(async (msg, style) => {
    replyStyle = style;
    const res = await dispatch(msg);
    if (!res) return;
    if (replyStyle === "ndjson") writeNdjson(res);
    else writeMessage(res);
  });
  process.stdin.resume();
  log(`ready v${VERSION} node=${process.version}`);
}

main().catch((err) => {
  log(`failed to start: ${err.message}`);
  process.exit(1);
});
