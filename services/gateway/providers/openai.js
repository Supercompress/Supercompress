"use strict";

const { iterateSseData, providerError } = require("./sse");
const { fetchUpstream, abortError, upstreamHttpError } = require("./upstream");

const DEFAULT_URL = "https://api.openai.com/v1/chat/completions";

/** OpenAI reasoning models take max_completion_tokens and reject max_tokens. */
function wantsMaxCompletionTokens(model) {
  return /^(o[0-9]|gpt-5)/i.test(String(model || ""));
}

function buildOpenAIBody(ctx, upstreamModel, providerName = "openai") {
  const n = ctx.normalized || {};
  const model = upstreamModel || ctx.model_routed || n.model;
  const body = {
    model,
    // Full message shape: tool_calls, tool_call_id, name and content parts pass through.
    messages: (n.messages || []).map((m) => {
      const out = { role: m.role, content: m.content };
      if (m.name != null) out.name = m.name;
      if (m.tool_calls) out.tool_calls = m.tool_calls;
      if (m.tool_call_id != null) out.tool_call_id = m.tool_call_id;
      return out;
    }),
    stream: n.stream === true,
  };
  for (const [k, v] of Object.entries(n.params || {})) body[k] = v;
  if (n.max_tokens != null) {
    const field =
      providerName === "openai" || providerName === "azure"
        ? n.max_tokens_field === "max_completion_tokens" || wantsMaxCompletionTokens(model)
          ? "max_completion_tokens"
          : "max_tokens"
        : "max_tokens";
    body[field] = n.max_tokens;
  }
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

function mapUsage(u) {
  if (!u) return null;
  const cached = u.prompt_tokens_details?.cached_tokens;
  return {
    input_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
    output_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
    ...(cached ? { cached_input_tokens: cached } : {}),
  };
}

/**
 * One adapter for every provider that speaks OpenAI Chat Completions
 * (OpenAI, Google, Mistral, xAI, DeepSeek, Groq, Together, Fireworks, Perplexity,
 * OpenRouter, Cerebras, Cohere, Ollama, Azure OpenAI). See registry.js.
 *
 * @param {object} options
 * @param {string} [options.apiKey]
 * @param {string} [options.baseUrl] — full chat-completions URL (default OpenAI)
 * @param {(model: string) => string} [options.urlFor] — per-model URL (Azure deployments)
 * @param {string} [options.providerName="openai"] — label on results and error codes
 * @param {string} [options.apiKeyEnv="OPENAI_API_KEY"] — env fallback for the key
 * @param {"bearer"|"api-key"} [options.auth="bearer"]
 * @param {boolean} [options.keyOptional=false] — local providers (Ollama) need no key
 * @param {typeof fetch} [options.fetchImpl]
 */
function createOpenAIProvider(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const baseUrl = options.baseUrl || DEFAULT_URL;
  const name = options.providerName || "openai";
  const keyEnv = options.apiKeyEnv === undefined ? "OPENAI_API_KEY" : options.apiKeyEnv;

  async function callOpenAI(ctx, call = {}) {
    const apiKey = options.apiKey || (keyEnv ? process.env[keyEnv] : "");
    if (!apiKey && !options.keyOptional) {
      const err = new Error(`${name}_api_key_missing`);
      err.status = 401;
      err.code = `${name}_api_key_missing`;
      throw err;
    }
    if (typeof fetchImpl !== "function") {
      const err = new Error("fetch_unavailable");
      err.status = 500;
      throw err;
    }

    const body = buildOpenAIBody(ctx, call.model, name);
    const url = typeof options.urlFor === "function" ? options.urlFor(body.model) : baseUrl;
    const headers = {
      "Content-Type": "application/json",
      Accept: body.stream ? "text/event-stream" : "application/json",
    };
    if (apiKey) {
      if (options.auth === "api-key") headers["api-key"] = apiKey;
      else headers.Authorization = `Bearer ${apiKey}`;
    }
    const { res, done, isTimedOut } = await fetchUpstream(
      fetchImpl,
      url,
      { method: "POST", headers, body: JSON.stringify(body) },
      ctx,
      { timeoutMs: options.timeoutMs }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      done();
      let parsed = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep text */
      }
      throw upstreamHttpError(name, res.status, parsed);
    }

    if (body.stream) {
      const acc = { content: "", usage: { input_tokens: 0, output_tokens: 0 } };
      const toolCalls = [];

      // Yields { content?, tool_calls? } deltas; sets finish_reason and usage on the result.
      async function* streamDeltas() {
        try {
          for await (const data of iterateSseData(res)) {
            if (!data || data === "[DONE]") continue;
            let json;
            try {
              json = JSON.parse(data);
            } catch {
              continue;
            }
            if (json.error) {
              const err = providerError(json.error.message || `${name}_stream_error`, 502, json);
              err.code = "upstream_stream_error";
              throw err;
            }
            const choice = json.choices?.[0];
            const delta = choice?.delta || {};
            const out = {};
            if (typeof delta.content === "string" && delta.content) {
              acc.content += delta.content;
              out.content = delta.content;
            }
            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
              mergeToolCallDeltas(toolCalls, delta.tool_calls);
              out.tool_calls = delta.tool_calls;
            }
            if (choice?.finish_reason) ctx.provider_result.finish_reason = choice.finish_reason;
            if (json.usage) acc.usage = mapUsage(json.usage);
            if (out.content || out.tool_calls) yield out;
          }
        } catch (err) {
          throw abortError(err, isTimedOut(), ctx.abort_signal);
        } finally {
          done();
        }
        ctx.provider_result.output = {
          content: acc.content,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        };
        ctx.provider_result.usage = acc.usage;
      }

      ctx.provider_result = {
        model: body.model,
        provider: name,
        output: { content: "" },
        usage: acc.usage,
        finish_reason: null,
        stream: streamDeltas(),
      };
      return ctx;
    }

    let json;
    try {
      json = await res.json();
    } catch (err) {
      throw abortError(err, isTimedOut(), ctx.abort_signal);
    } finally {
      done();
    }
    const choice = json.choices?.[0] || {};
    const toolCalls = Array.isArray(choice.message?.tool_calls) ? choice.message.tool_calls : null;
    ctx.provider_result = {
      model: json.model || body.model,
      provider: name,
      output: {
        content: extractContent(json),
        ...(toolCalls && toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: choice.finish_reason || null,
      usage: mapUsage(json.usage) || { input_tokens: 0, output_tokens: 0 },
      raw: json,
    };
    return ctx;
  }

  return callOpenAI;
}

/** Accumulate streamed tool_call fragments (by index) into complete tool calls. */
function mergeToolCallDeltas(acc, deltas) {
  for (const d of deltas) {
    const i = Number.isInteger(d.index) ? d.index : acc.length;
    const cur =
      acc[i] || (acc[i] = { id: d.id || "", type: "function", function: { name: "", arguments: "" } });
    if (d.id) cur.id = d.id;
    if (d.function?.name) cur.function.name += d.function.name;
    if (d.function?.arguments) cur.function.arguments += d.function.arguments;
  }
  return acc;
}

module.exports = {
  createOpenAIProvider,
  mergeToolCallDeltas,
  mapUsage,
  buildOpenAIBody,
  extractContent,
};
