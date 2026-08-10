/**
 * Compressor — calls SuperCompress API to compress conversation context.
 *
 * Protocol safety:
 * - Structured tool / multimodal messages pass through uncompressed.
 * - Compressed history is injected as a user digest (never elevated to system).
 * - All system messages are preserved (joined), not overwritten.
 * - Network / 5xx failures fail open (return original messages).
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const SUPERCOMPRESS_API =
  process.env.SUPERCOMPRESS_API_URL || "https://www.supercompress.dev/api/v1/compress";
const COMPRESS_TIMEOUT_MS = Number(process.env.SUPERCOMPRESS_COMPRESS_TIMEOUT_MS || 12_000);

function getApiKey() {
  if (process.env.SUPERCOMPRESS_API_KEY) return process.env.SUPERCOMPRESS_API_KEY;
  try {
    const configPath = path.join(
      process.env.SUPERCOMPRESS_CONFIG_DIR || path.join(os.homedir(), ".supercompress"),
      "config.json"
    );
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return config.api_key || null;
    }
  } catch {}
  return null;
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        return part.text || part.content || part.input_text || part.output_text || "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    return content.text || content.content || JSON.stringify(content);
  }
  return String(content);
}

/** True when history contains tool protocol that must not be flattened. */
function hasStructuredProtocol(messages) {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = String(msg.role || "");
    if (role === "tool" || role === "function") return true;
    if (msg.tool_calls || msg.function_call || msg.tool_call_id || msg.name) return true;
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (!part || typeof part !== "object") continue;
        const t = String(part.type || "");
        if (
          t &&
          t !== "text" &&
          t !== "input_text" &&
          t !== "output_text"
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Assemble compressible text context while preserving all system messages.
 * Last user message = query; prior non-system turns = context (text only).
 */
function assembleMessages(messages) {
  if (!messages || messages.length === 0) {
    return { context: "", query: "", systemMsgs: [] };
  }

  const systemMsgs = [];
  const nonSystem = [];

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      systemMsgs.push(msg);
    } else {
      nonSystem.push(msg);
    }
  }

  if (nonSystem.length === 0) {
    return { context: "", query: "", systemMsgs };
  }

  let query = "";
  const contextParts = [];
  const lastIdx = nonSystem.length - 1;
  const last = nonSystem[lastIdx];

  if (last.role === "user") {
    query = messageText(last.content);
    for (let i = 0; i < lastIdx; i++) {
      const msg = nonSystem[i];
      contextParts.push(`[${msg.role}]: ${messageText(msg.content)}`);
    }
  } else {
    for (const msg of nonSystem) {
      contextParts.push(`[${msg.role}]: ${messageText(msg.content)}`);
    }
    query = "Continue the conversation.";
  }

  return { context: contextParts.join("\n\n"), query, systemMsgs };
}

function detectAgentName() {
  if (process.env.SUPERCOMPRESS_AGENT_NAME) {
    return process.env.SUPERCOMPRESS_AGENT_NAME;
  }
  return "coding-agent";
}

function passThrough(messages, wordCount, skipReason) {
  return {
    messages,
    original_tokens: wordCount,
    compressed_tokens: wordCount,
    tokens_saved: 0,
    savings_pct: 0,
    skip_reason: skipReason,
  };
}

/**
 * Compress a list of messages via the SuperCompress API.
 */
async function compress(messages, agentName) {
  if (hasStructuredProtocol(messages)) {
    const words = messageText(JSON.stringify(messages)).split(/\s+/).length;
    return passThrough(messages, words, "structured_protocol");
  }

  const { context, query, systemMsgs } = assembleMessages(messages);
  const wordCount = context.split(/\s+/).filter(Boolean).length;
  if (wordCount < 100) {
    return passThrough(messages, wordCount, "context_too_small");
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      "SuperCompress API key not found. Run `supercompress setup` first " +
        "or set SUPERCOMPRESS_API_KEY environment variable."
    );
  }

  const agent = agentName || detectAgentName();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMPRESS_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(SUPERCOMPRESS_API, {
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
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const reason = err?.name === "AbortError" ? "timeout" : "network_error";
    console.error(`[supercompress] Compress ${reason} — passing through uncompressed`);
    return passThrough(messages, wordCount, reason);
  } finally {
    clearTimeout(timer);
  }

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
      console.error("[supercompress] Rate limit reached — passing through uncompressed");
      return passThrough(messages, wordCount, "rate_limited");
    }
    // 5xx / other: fail open so a hosted outage does not brick the agent.
    console.error(
      `[supercompress] API error (${response.status}) — passing through uncompressed`
    );
    return passThrough(messages, wordCount, `http_${response.status}`);
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

  if (!compressedText.trim()) {
    console.error(
      "[supercompress] Compression returned empty context — passing through uncompressed"
    );
    return passThrough(messages, originalTokens, "empty_compression");
  }

  const compressedMessages = [];
  for (const sys of systemMsgs) compressedMessages.push(sys);

  // User-role digest — never elevate tool/history content to system authority.
  compressedMessages.push({
    role: "user",
    content:
      `[Compressed prior context — ${tokensSaved} tokens saved (~${Math.round(tokensSavedPct)}%)]\n\n` +
      `${compressedText}\n\n` +
      `(End compressed context. Follow the next user message as the active ask.)`,
  });

  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  if (lastUserMsg) compressedMessages.push(lastUserMsg);

  return {
    messages: compressedMessages,
    original_tokens: originalTokens,
    compressed_tokens: keptTokens,
    tokens_saved: tokensSaved,
    savings_pct: tokensSavedPct,
  };
}

module.exports = {
  compress,
  assembleMessages,
  getApiKey,
  hasStructuredProtocol,
  messageText,
};
