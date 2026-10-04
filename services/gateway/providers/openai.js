"use strict";

const { iterateSseData, providerError } = require("./sse");

const DEFAULT_URL = "https://api.openai.com/v1/chat/completions";

function buildOpenAIBody(ctx) {
  const n = ctx.normalized || {};
  const body = {
    model: ctx.model_routed || n.model,
    messages: (n.messages || []).map((m) => ({
      role: m.role,
      content: m.content,
    })),
    stream: n.stream === true,
  };
  if (n.max_tokens != null) body.max_tokens = n.max_tokens;
  if (n.temperature != null) body.temperature = n.temperature;
  if (n.tools) body.tools = n.tools;
  if (body.stream) {
    body.stream_options = { include_usage: true };
  }
  return body;
}

function extractContent(json) {
  const choice = json?.choices?.[0];
  const msg = choice?.message?.content;
  if (typeof msg === "string") return msg;
  const delta = choice?.delta?.content;
  if (typeof delta === "string") return delta;
  return "";
}

/**
 * @param {object} options
 * @param {string} [options.apiKey]
 * @param {string} [options.baseUrl]
 * @param {typeof fetch} [options.fetchImpl]
 */
function createOpenAIProvider(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const baseUrl = options.baseUrl || DEFAULT_URL;

  async function callOpenAI(ctx) {
    const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      const err = new Error("openai_api_key_missing");
      err.status = 401;
      err.code = "openai_api_key_missing";
      throw err;
    }
    if (typeof fetchImpl !== "function") {
      const err = new Error("fetch_unavailable");
      err.status = 500;
      throw err;
    }

    const body = buildOpenAIBody(ctx);
    const res = await fetchImpl(baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
        /* keep text */
      }
      throw providerError(
        parsed?.error?.message || `openai_http_${res.status}`,
        res.status,
        parsed
      );
    }

    if (body.stream) {
      const acc = { content: "", usage: { input_tokens: 0, output_tokens: 0 } };

      async function* streamText() {
        for await (const data of iterateSseData(res)) {
          if (!data || data === "[DONE]") continue;
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }
          const piece = extractContent(json);
          if (piece) {
            acc.content += piece;
            yield piece;
          }
          if (json.usage) {
            acc.usage = {
              input_tokens: json.usage.prompt_tokens ?? json.usage.input_tokens ?? 0,
              output_tokens:
                json.usage.completion_tokens ?? json.usage.output_tokens ?? 0,
            };
          }
        }
        ctx.provider_result.output = { content: acc.content };
        ctx.provider_result.usage = acc.usage;
      }

      ctx.provider_result = {
        model: body.model,
        provider: "openai",
        output: { content: "" },
        usage: acc.usage,
        stream: streamText(),
      };
      return ctx;
    }

    const json = await res.json();
    ctx.provider_result = {
      model: json.model || body.model,
      provider: "openai",
      output: { content: extractContent(json) },
      usage: {
        input_tokens: json.usage?.prompt_tokens ?? 0,
        output_tokens: json.usage?.completion_tokens ?? 0,
      },
      raw: json,
    };
    return ctx;
  }

  return callOpenAI;
}

module.exports = {
  createOpenAIProvider,
  buildOpenAIBody,
  extractContent,
};
