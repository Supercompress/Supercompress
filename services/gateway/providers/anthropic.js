"use strict";

const { iterateSseData, providerError } = require("./sse");
const { fetchUpstream, abortError, upstreamHttpError } = require("./upstream");

const DEFAULT_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const STOP_REASON = {
  end_turn: "stop",
  stop_sequence: "stop",
  pause_turn: "stop",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
};

function mapStopReason(reason) {
  if (!reason) return null;
  return STOP_REASON[reason] || "stop";
}

/** OpenAI content (string or parts) → Anthropic content blocks. */
function toAnthropicBlocks(content) {
  if (content == null) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [{ type: "text", text: JSON.stringify(content) }];
  const blocks = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === "text") blocks.push({ type: "text", text: String(part.text || "") });
    else if (part.type === "image_url") {
      const url = String(part.image_url?.url || part.image_url || "");
      const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
      blocks.push(
        m
          ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }
          : { type: "image", source: { type: "url", url } }
      );
    } else blocks.push({ type: "text", text: JSON.stringify(part) });
  }
  return blocks;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && p.type === "text" ? String(p.text || "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

function parseArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    const v = JSON.parse(String(raw || "{}"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/**
 * Map OpenAI-shaped NormalizedRequest messages → Anthropic Messages API body.
 * system/developer → system; assistant tool_calls → tool_use blocks; tool messages →
 * tool_result blocks on a user turn. Consecutive same-role turns are merged.
 */
function buildAnthropicBody(ctx, upstreamModel) {
  const n = ctx.normalized || {};
  const systemParts = [];
  const messages = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };
  for (const m of n.messages || []) {
    const role = String(m.role || "user");
    if (role === "system" || role === "developer") {
      const t = textOf(m.content);
      if (t) systemParts.push(t);
      continue;
    }
    if (role === "tool") {
      push("user", [
        {
          type: "tool_result",
          tool_use_id: String(m.tool_call_id || ""),
          content: textOf(m.content),
        },
      ]);
      continue;
    }
    if (role === "assistant") {
      const blocks = toAnthropicBlocks(m.content);
      for (const tc of m.tool_calls || []) {
        blocks.push({
          type: "tool_use",
          id: String(tc.id || ""),
          name: String(tc.function?.name || ""),
          input: parseArgs(tc.function?.arguments),
        });
      }
      push("assistant", blocks);
      continue;
    }
    push("user", toAnthropicBlocks(m.content));
  }
  if (!messages.length) {
    messages.push({ role: "user", content: [{ type: "text", text: "" }] });
  }

  const body = {
    model: upstreamModel || ctx.model_routed || n.model,
    messages,
    max_tokens: n.max_tokens != null ? Number(n.max_tokens) : 4096,
    stream: n.stream === true,
  };
  if (systemParts.length) body.system = systemParts.join("\n\n");
  // OpenAI allows temperature 0-2; Anthropic accepts 0-1.
  if (n.temperature != null) body.temperature = Math.min(1, Math.max(0, Number(n.temperature) || 0));
  const p = n.params || {};
  if (p.top_p != null && n.temperature == null) body.top_p = p.top_p;
  if (p.stop != null) body.stop_sequences = Array.isArray(p.stop) ? p.stop : [p.stop];
  if (p.user) body.metadata = { user_id: String(p.user).slice(0, 256) };
  if (Array.isArray(n.tools) && n.tools.length) {
    body.tools = n.tools.map((t) => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description || "",
      input_schema: t.function?.parameters || t.input_schema || { type: "object", properties: {} },
    }));
    const tc = p.tool_choice;
    if (tc === "required") body.tool_choice = { type: "any" };
    else if (tc === "none") body.tool_choice = { type: "none" };
    else if (tc && typeof tc === "object" && tc.function?.name) {
      body.tool_choice = { type: "tool", name: tc.function.name };
    }
    if (p.parallel_tool_calls === false && body.tool_choice) {
      body.tool_choice.disable_parallel_tool_use = true;
    } else if (p.parallel_tool_calls === false) {
      body.tool_choice = { type: "auto", disable_parallel_tool_use: true };
    }
  }
  return body;
}

function extractTextBlocks(json) {
  const blocks = Array.isArray(json?.content) ? json.content : [];
  return blocks
    .filter((b) => b && b.type === "text")
    .map((b) => b.text || "")
    .join("");
}

function extractToolCalls(json) {
  const blocks = Array.isArray(json?.content) ? json.content : [];
  return blocks
    .filter((b) => b && b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      type: "function",
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));
}

/** Anthropic usage → normalized; cache reads and writes count as prompt tokens. */
function mapUsage(u = {}) {
  const cacheRead = Number(u.cache_read_input_tokens) || 0;
  const cacheWrite = Number(u.cache_creation_input_tokens) || 0;
  return {
    input_tokens: (Number(u.input_tokens) || 0) + cacheRead + cacheWrite,
    output_tokens: Number(u.output_tokens) || 0,
    ...(cacheRead ? { cached_input_tokens: cacheRead } : {}),
  };
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

  async function callAnthropic(ctx, call = {}) {
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

    const body = buildAnthropicBody(ctx, call.model);
    const { res, done, isTimedOut } = await fetchUpstream(
      fetchImpl,
      baseUrl,
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "Content-Type": "application/json",
          Accept: body.stream ? "text/event-stream" : "application/json",
        },
        body: JSON.stringify(body),
      },
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
        /* keep */
      }
      throw upstreamHttpError("anthropic", res.status, parsed);
    }

    if (body.stream) {
      const acc = { content: "", usage: { input_tokens: 0, output_tokens: 0 } };
      const toolCalls = [];
      const blockToTool = new Map();
      let rawUsage = {};

      async function* streamDeltas() {
        try {
          for await (const data of iterateSseData(res)) {
            if (!data) continue;
            let json;
            try {
              json = JSON.parse(data);
            } catch {
              continue;
            }
            const type = json.type;
            if (type === "error") {
              const err = providerError(json.error?.message || "anthropic_stream_error", 502, json);
              err.code = "upstream_stream_error";
              throw err;
            }
            if (type === "message_start" && json.message?.usage) {
              rawUsage = { ...json.message.usage };
            } else if (type === "content_block_start" && json.content_block?.type === "tool_use") {
              const idx = toolCalls.length;
              blockToTool.set(json.index, idx);
              const tc = {
                id: json.content_block.id,
                type: "function",
                function: { name: json.content_block.name, arguments: "" },
              };
              toolCalls.push(tc);
              yield {
                tool_calls: [
                  { index: idx, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } },
                ],
              };
            } else if (type === "content_block_delta" && json.delta?.type === "text_delta") {
              const piece = String(json.delta.text || "");
              if (piece) {
                acc.content += piece;
                yield { content: piece };
              }
            } else if (type === "content_block_delta" && json.delta?.type === "input_json_delta") {
              const idx = blockToTool.get(json.index);
              const frag = String(json.delta.partial_json || "");
              if (idx != null && frag) {
                toolCalls[idx].function.arguments += frag;
                yield { tool_calls: [{ index: idx, function: { arguments: frag } }] };
              }
            } else if (type === "message_delta") {
              if (json.usage) rawUsage = { ...rawUsage, ...json.usage };
              if (json.delta?.stop_reason) {
                ctx.provider_result.finish_reason = mapStopReason(json.delta.stop_reason);
              }
            }
          }
        } catch (err) {
          throw abortError(err, isTimedOut(), ctx.abort_signal);
        } finally {
          done();
        }
        acc.usage = mapUsage(rawUsage);
        ctx.provider_result.output = {
          content: acc.content,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        };
        ctx.provider_result.usage = acc.usage;
      }

      ctx.provider_result = {
        model: body.model,
        provider: "anthropic",
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
    const toolCalls = extractToolCalls(json);
    ctx.provider_result = {
      model: json.model || body.model,
      provider: "anthropic",
      output: {
        content: extractTextBlocks(json),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: mapStopReason(json.stop_reason),
      usage: mapUsage(json.usage),
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
  extractToolCalls,
  mapStopReason,
  mapUsage,
};
