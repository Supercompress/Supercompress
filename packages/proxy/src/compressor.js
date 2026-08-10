/**
 * Compressor — calls the SuperCompress hosted API to compress message context.
 *
 * Every call uses the user's SuperCompress API key (from config),
 * which authenticates against their plan and counts toward their
 * monthly token quota. This is the monetization hook.
 *
 * The hosted API endpoint: POST https://supercompress.dev/api/v1/compress
 */

// Native fetch handles the hosted API's compressed responses reliably on the
// Node versions supported by the CLI. node-fetch can report premature closes
// for larger gzip responses even when the server returned a valid body.
const fetch = globalThis.fetch;
const path = require("path");
const fs = require("fs");
const os = require("os");

// Use the canonical host directly. The apex domain redirects to www, and
// node-fetch can fail while replaying a compressed request across that 308.
const SUPERCOMPRESS_API = "https://www.supercompress.dev/api/v1/compress";

/**
 * Load the user's API key from config.
 * Falls back to SUPERCOMPRESS_API_KEY env var.
 */
function getApiKey() {
  const envKey = String(process.env.SUPERCOMPRESS_API_KEY || "").trim();
  // Ignore unresolved placeholders / non-sc_ values (Cursor used to inject
  // the literal "${SUPERCOMPRESS_API_KEY}" into MCP/proxy env).
  if (envKey && !envKey.includes("${") && envKey.startsWith("sc_")) {
    return envKey;
  }
  const configPath = path.join(
    process.env.SUPERCOMPRESS_CONFIG_DIR || path.join(os.homedir(), ".supercompress"),
    "config.json"
  );
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const key = String(config.api_key || "").trim();
    return key || null;
  } catch {
    return null;
  }
}

/**
 * Assemble the messages into a context + query pair for compression.
 *
 * Strategy:
 * - The last user message becomes the "query"
 * - All previous messages (system + assistant + user history) become the "context"
 * - If there's only one message, return it uncompressed
 */
function assembleMessages(messages) {
  if (!messages || messages.length === 0) {
    return { context: "", query: "", systemMsg: null };
  }

  let systemMsg = null;
  const nonSystem = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemMsg = msg;
    } else {
      nonSystem.push(msg);
    }
  }

  if (nonSystem.length === 0) {
    return { context: "", query: "", systemMsg };
  }

  // The last user message becomes the query
  let query = "";
  let contextParts = [];

  const lastIdx = nonSystem.length - 1;
  const last = nonSystem[lastIdx];

  if (last.role === "user") {
    query = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
    // Everything before the last user message is context
    for (let i = 0; i < lastIdx; i++) {
      const msg = nonSystem[i];
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      contextParts.push(`[${msg.role}]: ${content}`);
    }
  } else {
    // Last message is not user — compress everything
    for (const msg of nonSystem) {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      contextParts.push(`[${msg.role}]: ${content}`);
    }
    query = "Continue the conversation.";
  }

  const context = contextParts.join("\n\n");

  return { context, query, systemMsg };
}

/**
 * Detect the coding agent name from environment variables or config.
 * Used to tag compress API calls for per-agent usage tracking.
 */
function detectAgentName() {
  // Prefer explicit env (proxy / hooks set this per agent).
  if (process.env.SUPERCOMPRESS_AGENT_NAME) {
    return process.env.SUPERCOMPRESS_AGENT_NAME;
  }
  // Never use configured_agents[0] — setup lists every detected agent, so the
  // first entry (often Claude Code) would mis-attribute Cursor traffic.
  return "coding-agent";
}

/**
 * Compress a list of messages via the SuperCompress API.
 *
 * @param {Array} messages - The conversation messages to compress
 * @param {string} [agentName] - Optional coding agent name for usage tracking
 * Returns the compressed messages array (replacing context messages
 * with a compressed version) plus compression stats.
 */
async function compress(messages, agentName) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      "SuperCompress API key not found. Run `supercompress setup` first " +
      "or set SUPERCOMPRESS_API_KEY environment variable."
    );
  }

  const { context, query, systemMsg } = assembleMessages(messages);

  // Skip compression for very small contexts
  const wordCount = context.split(/\s+/).length;
  if (wordCount < 100) {
    // Too small to compress meaningfully — pass through
    return {
      messages,
      original_tokens: wordCount,
      compressed_tokens: wordCount,
      tokens_saved: 0,
      savings_pct: 0,
      skip_reason: "context_too_small",
    };
  }

  // Determine the coding agent name for usage tracking
  const agent = agentName || detectAgentName();

  // Call the SuperCompress API
  const response = await fetch(SUPERCOMPRESS_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({
      context,
      query,
      mode: "compiler",
      coding_agent: agent,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error(
        "Invalid SuperCompress API key. Run `supercompress setup` to update it " +
        "or get a new key at https://www.supercompress.dev/dashboard"
      );
    }
    const paywalled =
      response.status === 402 ||
      /PAYWALL|free_quota_exhausted|credits_exhausted/i.test(errorBody);
    if (paywalled) {
      const msg =
        "PAYWALL: Free 1M tokens used (or credits empty). Compression paused. " +
        "Add credits at https://www.supercompress.dev/dashboard#billing — $0.30/1M after free ($10 min).";
      console.error(`[supercompress] ${msg}`);
      const err = new Error(msg);
      err.status = 402;
      err.paywall = true;
      throw err;
    }
    if (response.status === 429) {
      // Pure rate limit — pass through uncompressed (do NOT soft-pass paywalls)
      console.error("[supercompress] Rate limit reached — passing through uncompressed");
      return {
        messages,
        original_tokens: wordCount,
        compressed_tokens: wordCount,
        tokens_saved: 0,
        savings_pct: 0,
        skip_reason: "rate_limited",
      };
    }
    throw new Error(`SuperCompress API error (${response.status}): ${errorBody.slice(0, 200)}`);
  }

  const result = await response.json();
  const compressedText = result.compressed_text || "";
  const originalTokens = result.original_tokens || wordCount;
  const keptTokens = result.kept_tokens || compressedText.split(/\s+/).length;
  const tokensSaved = result.tokens_saved ?? Math.max(0, originalTokens - keptTokens);
  const tokensSavedPct =
    result.tokens_saved_pct ??
    result.kv_savings_pct ??
    (originalTokens > 0 ? Math.round((tokensSaved / originalTokens) * 100) : 0);

  // Never forward an empty compression result — that would wipe agent context.
  // This can happen on highly repetitive dumps where the policy drops everything.
  if (!compressedText.trim()) {
    console.error(
      "[supercompress] Compression returned empty context — passing through uncompressed"
    );
    return {
      messages,
      original_tokens: result.original_tokens || wordCount,
      compressed_tokens: result.kept_tokens || result.original_tokens || wordCount,
      tokens_saved: 0,
      savings_pct: 0,
      skip_reason: "empty_compression",
    };
  }

  // Reconstruct the messages array with compressed content
  const compressedMessages = [];

  // Keep system message as-is
  if (systemMsg) {
    compressedMessages.push(systemMsg);
  }

  // Add compressed context as a system message
  compressedMessages.push({
    role: "system",
    content: `[Compressed context — ${tokensSaved} tokens saved (~${Math.round(tokensSavedPct)}%)]\n\n${compressedText}`,
  });

  // Add the last user message (query) unchanged
  const lastUserMsg = messages.filter((m) => m.role === "user").pop();
  if (lastUserMsg) {
    compressedMessages.push(lastUserMsg);
  }

  return {
    messages: compressedMessages,
    original_tokens: originalTokens,
    compressed_tokens: keptTokens,
    tokens_saved: tokensSaved,
    savings_pct: tokensSavedPct,
  };
}

module.exports = { compress, assembleMessages, getApiKey };
