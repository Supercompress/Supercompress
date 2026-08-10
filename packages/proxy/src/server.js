#!/usr/bin/env node

/**
 * SuperCompress Proxy — Express server
 *
 * OpenAI-compatible API proxy that compresses context before forwarding
 * to the real LLM provider (OpenAI, Anthropic). Every compression call
 * routes through the user's SuperCompress API key for plan-based billing.
 *
 * Endpoints:
 *   POST /v1/chat/completions  — OpenAI-compatible chat completion
 *   POST /v1/messages           — Anthropic-compatible message API
 *   GET  /v1/models             — List available models
 *   GET  /health                — Health check
 */

const express = require("express");
const zlib = require("zlib");
const compressor = require("./compressor");
const forwarder = require("./forwarder");
const VERSION = require("../package.json").version;

const PORT = parseInt(process.argv[2] || process.env.PROXY_PORT || "8080", 10);

const app = express();

const ZSTD_MAX_COMPRESSED_BYTES = 12 * 1024 * 1024; // 12 MB compressed cap
const ZSTD_MAX_DECODED_BYTES = 10 * 1024 * 1024; // match express.json limit

// Codex sends compact JSON with zstd content encoding. Decode it before
// Express's JSON parser, which otherwise rejects the request with HTTP 415.
app.use((req, res, next) => {
  if (req.headers["content-encoding"] !== "zstd") return next();

  const chunks = [];
  let total = 0;
  req.on("data", (chunk) => {
    total += chunk.length;
    if (total > ZSTD_MAX_COMPRESSED_BYTES) {
      res.status(413).json({ error: { message: "zstd body too large", type: "payload_too_large" } });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    try {
      if (typeof zlib.zstdDecompressSync !== "function") {
        res.status(415).json({ error: { message: "zstd request bodies require Node.js 22.15 or newer", type: "unsupported_encoding" } });
        return;
      }
      const decodedBuf = zlib.zstdDecompressSync(Buffer.concat(chunks));
      if (decodedBuf.length > ZSTD_MAX_DECODED_BYTES) {
        res.status(413).json({ error: { message: "decompressed zstd body too large", type: "payload_too_large" } });
        return;
      }
      req.body = JSON.parse(decodedBuf.toString("utf8"));
      req.headers["content-encoding"] = "identity";
      req._body = true;
      next();
    } catch (err) {
      res.status(400).json({ error: { message: `Invalid zstd JSON body: ${err.message}`, type: "invalid_request" } });
    }
  });
});

// ── Raw body capture for streaming detection ──
app.use(express.json({ limit: "10mb" }));

// ── Local-only proxy: block browser CSRF/CORS abuse of the user's SC key ──
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  // Do not advertise wildcard CORS — coding agents are non-browser clients.
  const origin = req.headers.origin;
  if (origin && /^https?:\/\//i.test(String(origin)) && req.path !== "/health") {
    return res.status(403).json({
      error: {
        message: "Browser origins cannot call the local SuperCompress proxy",
        type: "forbidden_origin",
      },
    });
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Health check ──
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "supercompress",
    version: VERSION,
    endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/responses"],
  });
});

// ── List models ──
app.get("/v1/models", (req, res) => {
  const models = [
      { id: "gpt-5.4-mini", object: "model", created: 1700000000, owned_by: "openai" },
      { id: "gpt-5.4", object: "model", created: 1700000000, owned_by: "openai" },
      { id: "gpt-4o", object: "model", created: 1700000000, owned_by: "openai" },
      { id: "gpt-4o-mini", object: "model", created: 1700000000, owned_by: "openai" },
      { id: "gpt-4-turbo", object: "model", created: 1700000000, owned_by: "openai" },
      { id: "gpt-4", object: "model", created: 1700000000, owned_by: "openai" },
      { id: "gpt-3.5-turbo", object: "model", created: 1700000000, owned_by: "openai" },
      { id: "claude-3-5-sonnet-20241022", object: "model", created: 1700000000, owned_by: "anthropic" },
      { id: "claude-3-haiku-20240307", object: "model", created: 1700000000, owned_by: "anthropic" },
      { id: "claude-3-opus-20240229", object: "model", created: 1700000000, owned_by: "anthropic" },
  ];
  // OpenAI clients expect `data`; Codex's model manager expects richer `models` records.
  const codexModels = models.map((model) => ({
    slug: model.id,
    display_name: model.id,
    description: "OpenAI-compatible model through SuperCompress",
    context_window: 200000,
    max_output_tokens: 32768,
    supports_reasoning_summaries: true,
    supported_reasoning_levels: [
      { effort: "minimal", description: "Fast responses with lighter reasoning" },
      { effort: "low", description: "Quick responses with limited reasoning" },
      { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
      { effort: "high", description: "More reasoning for difficult problems" },
      { effort: "xhigh", description: "Maximum reasoning depth for the hardest problems" },
    ],
    default_reasoning_level: "medium",
    default_reasoning_effort: "medium",
    input_modalities: ["text"],
    supports_parallel_tool_calls: true,
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    base_instructions: "",
    model_messages: null,
    upgrade: null,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    supports_image_detail_original: true,
    truncation_policy: { mode: "tokens", limit: 10000 },
    tool_mode: "code_mode_only",
    use_responses_lite: false,
    include_skills_usage_instructions: false,
    auto_review_model_override: null,
    reasoning_summary_format: "experimental",
    experimental_supported_tools: [],
  }));
  res.json({ object: "list", data: models, models: codexModels });
});

// Codex probes this URL for a Responses WebSocket before falling back to HTTP.
// The proxy intentionally uses the HTTP Responses API, so fail fast and let
// Codex take its supported fallback path.
app.get("/v1/responses", (req, res) => {
  res.status(405).set("Allow", "POST").json({ error: { message: "Use POST /v1/responses", type: "method_not_allowed" } });
});

/**
 * Detect the coding agent name from the incoming request.
 * Uses User-Agent header or known agent patterns.
 */
function detectCodingAgent(req) {
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  if (ua.includes("cursor")) return "cursor";
  if (ua.includes("windsurf")) return "windsurf";
  if (ua.includes("continue")) return "continue";
  if (ua.includes("cline")) return "cline";
  if (ua.includes("claude")) return "claude-code";
  if (ua.includes("aider")) return "aider";
  if (ua.includes("copilot")) return "copilot";
  if (ua.includes("codex")) return "codex";
  if (ua.includes("openai")) return "openai-client";
  if (ua.includes("python") || ua.includes("curl") || ua.includes("node")) return "api-client";
  // Check for custom header
  const agentHeader = req.headers["x-agent-name"];
  if (agentHeader) return agentHeader.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  return "coding-agent";
}

// ── OpenAI-compatible chat completions ──
app.post("/v1/chat/completions", async (req, res) => {
  const startTime = Date.now();
  const { model, messages = [], ...rest } = req.body;

  if (!messages || messages.length === 0) {
    return res.status(422).json({ error: { message: "No messages provided", type: "invalid_request" } });
  }

  try {
    // Step 1: Detect which coding agent is calling
    const agentName = detectCodingAgent(req);

    // Step 2: Compress context
    const compressed = await compressor.compress(messages, agentName);

    // Step 3: Forward to real provider
    await forwarder.forwardChat(model, compressed, rest, res, req.headers.authorization);

    // Log stats to stderr (captured by parent process)
    const totalMs = Date.now() - startTime;
    console.error(`[supercompress] ${model} | ${compressed.original_tokens}→${compressed.compressed_tokens} tok | ${compressed.savings_pct}% saved | ${totalMs}ms total`);
  } catch (err) {
    console.error("[supercompress] Error:", err.message);
    if (!res.headersSent) {
      const paywall = Boolean(err.paywall || err.status === 402);
      res.status(paywall ? 402 : 502).json({
        error: {
          message: err.message || "SuperCompress proxy error",
          type: paywall ? "paywall" : "proxy_error",
          ...(paywall
            ? { upgrade_url: "https://www.supercompress.dev/dashboard#billing" }
            : {}),
        },
      });
    }
  }
});

// ── OpenAI Responses API (Codex and newer OpenAI clients) ──
app.post("/v1/responses", async (req, res) => {
  const startTime = Date.now();
  const { input, ...rest } = req.body || {};
  if (input === undefined) {
    return res.status(422).json({ error: { message: "No input provided", type: "invalid_request" } });
  }

  try {
    const agentName = detectCodingAgent(req);
    let compressed;
    if (forwarder.responsesInputHasStructuredItems(input)) {
      // Tool / function_call items cannot round-trip through text compression.
      const approx = JSON.stringify(input).split(/\s+/).length;
      compressed = {
        messages: [],
        original_tokens: approx,
        compressed_tokens: approx,
        tokens_saved: 0,
        savings_pct: 0,
        skip_reason: "structured_protocol",
      };
    } else {
      compressed = await compressor.compress(forwarder.responsesInputToMessages(input), agentName);
    }
    await forwarder.forwardResponses(
      rest.model,
      compressed,
      rest,
      res,
      req.headers.authorization,
      input
    );
    const totalMs = Date.now() - startTime;
    console.error(`[supercompress] responses | ${rest.model || "unknown"} | ${compressed.original_tokens}→${compressed.compressed_tokens} tok | ${compressed.savings_pct}% saved | ${totalMs}ms total`);
  } catch (err) {
    console.error("[supercompress] Error:", err.message);
    if (!res.headersSent) {
      const paywall = Boolean(err.paywall || err.status === 402);
      res.status(paywall ? 402 : 502).json({
        error: {
          message: err.message || "SuperCompress proxy error",
          type: paywall ? "paywall" : "proxy_error",
          ...(paywall
            ? { upgrade_url: "https://www.supercompress.dev/dashboard#billing" }
            : {}),
        },
      });
    }
  }
});

// ── Anthropic-compatible messages ──
app.post("/v1/messages", async (req, res) => {
  const startTime = Date.now();
  const { model, messages = [], system, ...rest } = req.body;

  if (!messages || messages.length === 0) {
    return res.status(422).json({ error: { message: "No messages provided", type: "invalid_request" } });
  }

  try {
    // Step 1: Detect which coding agent is calling
    const agentName = detectCodingAgent(req);

    // Step 2: Compress context
    const compressed = await compressor.compress(messages, agentName);

    // Step 2: Forward to Anthropic
    await forwarder.forwardAnthropic(
      model,
      compressed,
      system,
      rest,
      res,
      req.headers.authorization,
      req.headers["x-api-key"]
    );

    const totalMs = Date.now() - startTime;
    console.error(`[supercompress] ${model} | ${compressed.original_tokens}→${compressed.compressed_tokens} tok | ${compressed.savings_pct}% saved | ${totalMs}ms total`);
  } catch (err) {
    console.error("[supercompress] Error:", err.message);
    if (!res.headersSent) {
      const paywall = Boolean(err.paywall || err.status === 402);
      res.status(paywall ? 402 : 502).json({
        error: {
          message: err.message || "SuperCompress proxy error",
          type: paywall ? "paywall" : "proxy_error",
          ...(paywall
            ? { upgrade_url: "https://www.supercompress.dev/dashboard#billing" }
            : {}),
        },
      });
    }
  }
});

// ── Catch-all ──
app.use((req, res) => {
  res.status(404).json({ error: { message: `Not found: ${req.method} ${req.path}`, type: "not_found" } });
});

// ── Start ──
app.listen(PORT, "127.0.0.1", () => {
  console.error(`[supercompress] Proxy running on http://127.0.0.1:${PORT}/v1`);
  console.error(`[supercompress] Configure your coding agent to use http://127.0.0.1:${PORT}/v1`);
});
