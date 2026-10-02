"use strict";

/**
 * Chat Completions ↔ NormalizedRequest adapters.
 * Internal center is NormalizedRequest — this is the first ingress adapter only.
 */

function fromChatCompletions(body = {}, meta = {}) {
  const messages = Array.isArray(body.messages)
    ? body.messages.map((m) => ({
        role: String(m?.role || "user"),
        content: m?.content,
      }))
    : [];
  return {
    id: body.id,
    messages,
    tools: body.tools,
    model: body.model,
    stream: body.stream === true,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
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
  } else if (output != null) {
    content = JSON.stringify(output);
  }
  const resp = {
    id: normalizedResponse.id || "chatcmpl_stub",
    object: "chat.completion",
    model: normalizedResponse.model || "unknown",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: normalizedResponse.usage?.input_tokens ?? 0,
      completion_tokens: normalizedResponse.usage?.output_tokens ?? 0,
      total_tokens:
        (normalizedResponse.usage?.input_tokens ?? 0) +
        (normalizedResponse.usage?.output_tokens ?? 0),
    },
  };
  if (normalizedResponse.compression) {
    resp.sc_compression_trace = normalizedResponse.compression;
  }
  if (normalizedResponse.request_id) {
    resp.sc_request_id = normalizedResponse.request_id;
  }
  return resp;
}

module.exports = {
  fromChatCompletions,
  toChatCompletions,
};
