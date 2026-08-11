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
const crypto = require("crypto");

const SUPERCOMPRESS_API =
  process.env.SUPERCOMPRESS_API_URL || "https://www.supercompress.dev/api/v1/compress";
const COMPRESS_TIMEOUT_MS = Number(process.env.SUPERCOMPRESS_COMPRESS_TIMEOUT_MS || 12_000);

function isValidApiKey(value) {
  const key = String(value || "").trim();
  if (!key) return false;
  if (key.includes("${") || /SUPERCOMPRESS_API_KEY|your.?key|xxx|placeholder/i.test(key)) {
    return false;
  }
  // Real keys look like sc_live_… / sc_<agent>_…
  return /^sc_[a-z0-9]+_[A-Za-z0-9]{12,}$/.test(key);
}

function getApiKey() {
  const envKey = String(process.env.SUPERCOMPRESS_API_KEY || "").trim();
  if (isValidApiKey(envKey)) return envKey;
  try {
    const configPath = path.join(
      process.env.SUPERCOMPRESS_CONFIG_DIR || path.join(os.homedir(), ".supercompress"),
      "config.json"
    );
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (isValidApiKey(config.api_key)) return config.api_key;
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
 * For tool-heavy histories: compress eligible older text turns, keep structured
 * / recent protocol messages verbatim.
 */
function splitCompressiblePrefix(messages) {
  const systemMsgs = [];
  const rest = [];
  for (const msg of messages || []) {
    if (msg?.role === "system" || msg?.role === "developer") systemMsgs.push(msg);
    else rest.push(msg);
  }
  // Keep the trailing window (often active tool loop) untouched.
  const KEEP_TAIL = 6;
  if (rest.length <= KEEP_TAIL) {
    return { systemMsgs, compressible: [], preserved: rest, query: "" };
  }
  const compressible = [];
  const preservedHead = [];
  const head = rest.slice(0, -KEEP_TAIL);
  for (const msg of head) {
    const structured =
      msg.role === "tool" ||
      msg.role === "function" ||
      msg.tool_calls ||
      msg.function_call ||
      msg.tool_call_id ||
      Array.isArray(msg.content);
    if (structured) {
      // Keep structured tool turns verbatim, in original order (never unshift).
      preservedHead.push(msg);
    } else {
      compressible.push(msg);
    }
  }
  const preserved = [...preservedHead, ...rest.slice(-KEEP_TAIL)];
  // Rank against the active user ask from the full history (usually in the tail),
  // not an older user turn that happened to land in the compressible prefix.
  let query = "Continue the conversation.";
  const lastUser = [...rest].reverse().find((m) => m.role === "user");
  if (lastUser) query = messageText(lastUser.content) || query;
  return { systemMsgs, compressible, preserved, query };
}

async function compress(messages, agentName) {
  if (hasStructuredProtocol(messages)) {
    const split = splitCompressiblePrefix(messages);
    const context = split.compressible
      .map((m) => `[${m.role}]: ${messageText(m.content)}`)
      .join("\n\n");
    const wordCount = context.split(/\s+/).filter(Boolean).length;
    if (wordCount < 100) {
      const words = messageText(JSON.stringify(messages)).split(/\s+/).length;
      return passThrough(messages, words, "structured_protocol");
    }
    // Fall through to API compress using assembled context, then re-stitch.
    const apiKey = getApiKey();
    if (!apiKey) {
      const words = messageText(JSON.stringify(messages)).split(/\s+/).length;
      return passThrough(messages, words, "structured_protocol");
    }
    const agent = agentName || detectAgentName();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COMPRESS_TIMEOUT_MS);
    const idempotencyKey = crypto.randomUUID();
    try {
      const response = await fetch(SUPERCOMPRESS_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          context,
          query: split.query,
          mode: "compiler",
          coding_agent: agent,
          source: "agent",
          request_id: idempotencyKey,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const words = messageText(JSON.stringify(messages)).split(/\s+/).length;
        return passThrough(messages, words, "structured_protocol");
      }
      const data = await response.json();
      const digest = String(data.compressed_text || "").trim();
      const out = [
        ...split.systemMsgs,
        ...(digest
          ? [
              {
                role: "user",
                content: `[Compressed context — query kept whole]\n\n${digest}`,
              },
            ]
          : []),
        ...split.preserved,
      ];
      const original = wordCount;
      const compressed = digest.split(/\s+/).filter(Boolean).length;
      return {
        messages: out,
        original_tokens: data.original_tokens || original,
        compressed_tokens: data.kept_tokens || compressed,
        tokens_saved: data.tokens_saved || Math.max(0, original - compressed),
        savings_pct: data.tokens_saved_pct || 0,
        skip_reason: null,
      };
    } catch {
      const words = messageText(JSON.stringify(messages)).split(/\s+/).length;
      return passThrough(messages, words, "structured_protocol");
    } finally {
      clearTimeout(timer);
    }
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
  const idempotencyKey = crypto.randomUUID();

  let response;
  try {
    response = await fetch(SUPERCOMPRESS_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        context,
        query,
        mode: "compiler",
        coding_agent: agent,
        request_id: idempotencyKey,
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
  splitCompressiblePrefix,
};
