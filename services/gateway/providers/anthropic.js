"use strict";

const { iterateSseData, providerError } = require("./sse");

const DEFAULT_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Map OpenAI-shaped NormalizedRequest messages → Anthropic Messages API body.
 */
function buildAnthropicBody(ctx) {
  const n = ctx.normalized || {};
  const systemParts = [];
  const messages = [];
  for (const m of n.messages || []) {
    const role = String(m.role || "user");
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    if (role === "system") {
      systemParts.push(content);
      continue;
    }
    const mappedRole = role === "assistant" ? "assistant" : "user";
    // Anthropic requires alternating roles; merge consecutive same-role.
    const last = messages[messages.length - 1];
    if (last && last.role === mappedRole) {
      last.content = `${last.content}\n${content}`;
    } else {
      messages.push({ role: mappedRole, content });
    }
  }
  if (!messages.length) {
    messages.push({ role: "user", content: "" });
  }

  const body = {
    model: ctx.model_routed || n.model,
    messages,
    max_tokens: n.max_tokens != null ? Number(n.max_tokens) : 1024,
    stream: n.stream === true,
  };
  if (systemParts.length) body.system = systemParts.join("\n\n");
  if (n.temperature != null) body.temperature = n.temperature;
  if (Array.isArray(n.tools) && n.tools.length) {
    body.tools = n.tools.map((t) => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description || "",
      input_schema: t.function?.parameters || t.input_schema || { type: "object", properties: {} },
    }));
  }
  return body;
}

function extractTextBlocks(json) {
  const blocks = Array.isArray(json?.content) ? json.content : [];
  return blocks
    .filter((b) => b && (b.type === "text" || typeof b.text === "string"))
    .map((b) => b.text || "")
    .join("");
}

/**
 * @param {object} options
 * @param {string} [options.apiKey]
 * @param {string} [options.baseUrl]
 * @param {typeof fetch} [options.fetchImpl]
 */
function createAnthropicProvider(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const baseUrl = options.baseUrl || DEFAULT_URL;

  async function callAnthropic(ctx) {
    const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      const err = new Error("anthropic_api_key_missing");
      err.status = 401;
      err.code = "anthropic_api_key_missing";
      throw err;
    }
    if (typeof fetchImpl !== "function") {
      const err = new Error("fetch_unavailable");
      err.status = 500;
      throw err;
    }

    const body = buildAnthropicBody(ctx);
    const res = await fetchImpl(baseUrl, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
        Accept: body.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep */
      }
      throw providerError(
        parsed?.error?.message || parsed?.message || `anthropic_http_${res.status}`,
        res.status,
        parsed
      );
    }

    if (body.stream) {
      const acc = { content: "", usage: { input_tokens: 0, output_tokens: 0 } };

      async function* streamText() {
        for await (const data of iterateSseData(res)) {
          if (!data) continue;
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }
          const type = json.type;
          if (type === "content_block_delta" && json.delta?.type === "text_delta") {
            const piece = String(json.delta.text || "");
            if (piece) {
              acc.content += piece;
              yield piece;
            }
          } else if (type === "message_delta" && json.usage) {
            acc.usage.output_tokens = json.usage.output_tokens ?? acc.usage.output_tokens;
          } else if (type === "message_start" && json.message?.usage) {
            acc.usage.input_tokens = json.message.usage.input_tokens ?? 0;
            acc.usage.output_tokens = json.message.usage.output_tokens ?? 0;
          }
        }
        ctx.provider_result.output = { content: acc.content };
        ctx.provider_result.usage = acc.usage;
      }

      ctx.provider_result = {
        model: body.model,
        provider: "anthropic",
        output: { content: "" },
        usage: acc.usage,
        stream: streamText(),
      };
      return ctx;
    }

    const json = await res.json();
    ctx.provider_result = {
      model: json.model || body.model,
      provider: "anthropic",
      output: { content: extractTextBlocks(json) },
      usage: {
        input_tokens: json.usage?.input_tokens ?? 0,
        output_tokens: json.usage?.output_tokens ?? 0,
      },
      raw: json,
    };
    return ctx;
  }

  return callAnthropic;
}

module.exports = {
  createAnthropicProvider,
  buildAnthropicBody,
  extractTextBlocks,
};
