"use strict";

/**
 * Chat Completions ↔ NormalizedRequest adapters.
 * Internal center is NormalizedRequest — this is the first ingress adapter only.
 */

/**
 * Chat Completions request params forwarded upstream unchanged (provider adapters decide
 * which ones their API accepts). Anything not listed here is dropped.
 */
const PASSTHROUGH_PARAMS = [
  "top_p",
  "stop",
  "n",
  "seed",
  "response_format",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "tool_choice",
  "parallel_tool_calls",
  "user",
  "reasoning_effort",
];

/** Keep the full OpenAI message shape: content parts, tool calls and tool results. */
function normalizeMessage(m) {
  const out = { role: String(m?.role || "user"), content: m?.content ?? null };
  if (m && typeof m === "object") {
    if (m.name != null) out.name = m.name;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) out.tool_calls = m.tool_calls;
    if (m.tool_call_id != null) out.tool_call_id = m.tool_call_id;
  }
  return out;
}

function fromChatCompletions(body = {}, meta = {}) {
  const messages = Array.isArray(body.messages) ? body.messages.map(normalizeMessage) : [];
  const params = {};
  for (const k of PASSTHROUGH_PARAMS) {
    if (body[k] !== undefined) params[k] = body[k];
  }
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  return {
    id: body.id,
    messages,
    tools: body.tools,
    model: body.model,
    stream: body.stream === true,
    max_tokens: maxTokens,
    // Which field the client used, so OpenAI reasoning models get max_completion_tokens.
    max_tokens_field: body.max_completion_tokens != null ? "max_completion_tokens" : "max_tokens",
    temperature: body.temperature,
    params,
    metadata: {
      org_id: meta.org_id ?? body.metadata?.org_id,
      project_id: meta.project_id ?? body.metadata?.project_id,
      key_id: meta.key_id ?? body.metadata?.key_id,
      agent_id: meta.agent_id ?? body.metadata?.agent_id,
      sc_compress:
        meta.sc_compress != null
          ? !!meta.sc_compress
          : body.sc_compress != null
            ? !!body.sc_compress
            : true,
      idempotency_key:
        meta.idempotency_key ??
        body.idempotency_key ??
        body.metadata?.idempotency_key,
    },
    raw: body,
  };
}

function toChatCompletions(normalizedResponse = {}) {
  const output = normalizedResponse.output;
  let content = "";
  if (typeof output === "string") content = output;
  else if (output && typeof output === "object" && output.content != null) {
    content = output.content;
  } else if (output != null && typeof output !== "object") {
    content = String(output);
  }
  const toolCalls =
    output && typeof output === "object" && Array.isArray(output.tool_calls) && output.tool_calls.length
      ? output.tool_calls
      : null;
  const message = { role: "assistant", content: toolCalls && !content ? null : content };
  if (toolCalls) message.tool_calls = toolCalls;
  const usage = normalizedResponse.usage || {};
  const resp = {
    id: normalizedResponse.id || "chatcmpl_stub",
    object: "chat.completion",
    created: normalizedResponse.created || Math.floor(Date.now() / 1000),
    model: normalizedResponse.model || "unknown",
    choices: [
      {
        index: 0,
        message,
        finish_reason: normalizedResponse.finish_reason || (toolCalls ? "tool_calls" : "stop"),
      },
    ],
    usage: {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    },
  };
  if (usage.cached_input_tokens) {
    resp.usage.prompt_tokens_details = { cached_tokens: usage.cached_input_tokens };
  }
  if (normalizedResponse.compression) {
    resp.sc_compression_trace = normalizedResponse.compression;
  }
  if (normalizedResponse.economics) {
    resp.sc_economics = normalizedResponse.economics;
  }
  if (normalizedResponse.request_id) {
    resp.sc_request_id = normalizedResponse.request_id;
  }
  return resp;
}

module.exports = {
  PASSTHROUGH_PARAMS,
  normalizeMessage,
  fromChatCompletions,
  toChatCompletions,
};
