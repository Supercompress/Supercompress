#!/usr/bin/env node
/**
 * SuperCompress MCP Server
 *
 * Exposes compress, retrieve, and simple_hash as tools for MCP-compatible
 * agents (Claude Desktop, Claude Code, Cursor, etc.).
 *
 * LEGACY local MCP entrypoint — runs the local *compiler* engine only
 * (no hosted Neural Keep). No API key needed for local compress.
 * Coding agents should prefer `packages/proxy` / `npx supercompress setup`,
 * which uses the hosted API (context leaves the machine; account required).
 * Retrieval checks the in-memory CCR cache first, then optionally falls
 * back to the hosted API if SUPERCOMPRESS_API_KEY is set.
 *
 * Usage:
 *   node mcp/server.js
 *
 * Claude Desktop config (claude_desktop_config.json):
 * {
 *   "mcpServers": {
 *     "supercompress": {
 *       "command": "node",
 *       "args": ["/path/to/supercompress/mcp/server.js"]
 *     }
 *   }
 * }
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

// Reuse the server-side engine from the hosted API
const { compressAdaptive, compressCCR, simpleHash, getEngine } = require("../api/_lib/engine");

const server = new Server(
  { name: "supercompress", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ──

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "compress",
      description: `Compress a long text context before sending it to an LLM. Removes low-value tokens while preserving query-critical evidence. Returns the compressed text followed by a JSON block with token savings stats.

The "compiler" mode (default) removes the most tokens possible while keeping answer-critical context. The "ccr" mode produces reversible compression — dropped blocks are replaced with [SC-Retrieve: hash] markers so the original text can be retrieved later via the retrieve tool.

Use this when you need to fit a long context into a smaller context window, reduce costs, or speed up inference.`,
      inputSchema: {
        type: "object",
        properties: {
          context: { type: "string", description: "The full context text to compress" },
          query: { type: "string", description: "The question or task that defines what content is important to preserve" },
          mode: {
            type: "string",
            enum: ["compiler", "ccr"],
            description: '"compiler" (default, max savings) or "ccr" (reversible with retrieval markers)',
            default: "compiler",
          },
        },
        required: ["context", "query"],
      },
    },
    {
      name: "retrieve",
      description: `Retrieve the original text that was removed during a CCR (Cache, Compress, Retrieve) compression. Use the hash from a [SC-Retrieve: hash] marker found in compressed output.

First checks the in-memory cache (populated by compress calls in the same session). If not found and SUPERCOMPRESS_API_KEY is set, falls back to the hosted retrieval API.

Returns the original text followed by a JSON block with metadata.`,
      inputSchema: {
        type: "object",
        properties: {
          hash: {
            type: "string",
            description: "The hash from a [SC-Retrieve: hash] marker in compressed text (format: 8-hex-chars_hex-length)",
          },
        },
        required: ["hash"],
      },
    },
    {
      name: "simple_hash",
      description: "Compute the SuperCompress content-addressed hash for a given text. Useful for checking if content was already cached before compressing, or for verifying hash format.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to hash using the SuperCompress simpleHash function" },
        },
        required: ["text"],
      },
    },
  ],
}));

// ── Tool execution ──

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "compress": {
        const context = String(args?.context || "");
        const query = String(args?.query || "Summarize this context.");
        const mode = String(args?.mode || "compiler");

        if (!context.trim()) {
          return { content: [{ type: "text", text: "Error: context parameter is required and cannot be empty." }] };
        }

        let result;
        if (mode === "ccr") {
          result = await compressCCR(context, query);
        } else {
          result = await compressAdaptive(context, query);
        }

        return {
          content: [
            {
              type: "text",
              text: result.compressed_text,
            },
            {
              type: "text",
              text: JSON.stringify({
                _stats: true,
                original_tokens: result.original_tokens,
                kept_tokens: result.kept_tokens,
                tokens_saved: Math.max(0, result.original_tokens - result.kept_tokens),
                tokens_saved_pct: Math.round(result.tokens_saved_pct * 100) / 100,
                kept_line_ratio: result.kept_line_ratio,
                policy_name: result.policy_name,
                mode: mode,
                answer_quality: result.answer_quality,
                important_kept_pct: result.important_kept_pct,
                compression_risk: result.compression_risk,
                preprocessor: result.preprocessor || "none",
                ccr: result.ccr || null,
              }, null, 2),
            },
          ],
        };
      }

      case "retrieve": {
        const hash = String(args?.hash || "").trim();

        if (!hash) {
          return { content: [{ type: "text", text: "Error: hash parameter is required." }] };
        }

        if (!/^[0-9a-f]{8}_[0-9a-f]+$/.test(hash)) {
          return {
            content: [{
              type: "text",
              text: `Error: Invalid hash format "${hash}". Expected format: 8 hex characters, underscore, then hex length (e.g. "a1b2c3d4_2f").`,
            }],
          };
        }

        // First try the in-memory CCR cache (populated by compressCCR in the same session)
        const E = getEngine();
        let original = null;
        let source = null;

        try {
          original = E.ccrRetrieve(hash);
          if (original) source = "cache";
        } catch (_) {
          // ccrRetrieve may throw if hash not found; ignore
        }

        // Fall back to hosted API if configured
        if (!original) {
          const apiKey = (process.env.SUPERCOMPRESS_API_KEY || "").trim();
          if (apiKey) {
            try {
              const https = require("https");
              const url = new URL("https://supercompress.dev/api/retrieve");
              url.searchParams.set("hash", hash);

              const response = await new Promise((resolve, reject) => {
                const req = https.get(url.href, {
                  headers: { "X-API-Key": apiKey },
                  timeout: 10000,
                }, (res) => {
                  let data = "";
                  res.on("data", (chunk) => data += chunk);
                  res.on("end", () => {
                    if (res.statusCode === 200) {
                      try { resolve(JSON.parse(data)); }
                      catch (e) { reject(new Error("Invalid API response")); }
                    } else {
                      reject(new Error(`API returned ${res.statusCode}`));
                    }
                  });
                });
                req.on("error", reject);
                req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
              });

              if (response?.original) {
                original = response.original;
                source = "api";
              }
            } catch (_) {
              // API fallback failed; continue to error message
            }
          }
        }

        if (original) {
          return {
            content: [
              { type: "text", text: original },
              {
                type: "text",
                text: JSON.stringify({
                  _stats: true,
                  hash,
                  source,
                  length: original.length,
                  token_count: original.split(/\s+/).length,
                }, null, 2),
              },
            ],
          };
        }

        return {
          content: [{
            type: "text",
            text: `Hash "${hash}" not found in local cache. To retrieve persisted hashes from the hosted API, set the SUPERCOMPRESS_API_KEY environment variable. Otherwise, compress the content with mode="ccr" in the same session first — the cache is ephemeral and only persists for the current session.`,
          }],
        };
      }

      case "simple_hash": {
        const text = String(args?.text || "");
        if (!text) {
          return { content: [{ type: "text", text: "Error: text parameter is required." }] };
        }
        const hash = simpleHash(text);
        return {
          content: [
            {
              type: "text",
              text: hash,
            },
            {
              type: "text",
              text: JSON.stringify({
                _stats: true,
                input_length: text.length,
                hash,
                format: "8-hex-chars_hex-length (content-addressed)",
              }, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message || String(err)}` }],
      isError: true,
    };
  }
});

// ── Start server ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is used for logging so it doesn't interfere with the stdio MCP protocol
  console.error("SuperCompress MCP server running on stdio");
}

main().catch((err) => {
  console.error("SuperCompress MCP server fatal error:", err);
  process.exit(1);
});
