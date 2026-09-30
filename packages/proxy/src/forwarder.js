/**
 * Forwarder — forwards compressed messages to the real LLM provider.
 *
 * Supports:
 *   - OpenAI (POST /v1/chat/completions) — streaming + non-streaming
 *   - Anthropic (POST /v1/messages) — streaming + non-streaming
 *   - OpenAI Responses (POST /v1/responses)
 *
 * Uses Node's native fetch (Node >=18). Streaming preserves tool_calls and
 * other delta fields; SSE lines are buffered across TCP chunks, and multi-byte
 * characters are decoded across them.
 */

const { StringDecoder } = require("string_decoder");

const OPENAI_BASE = process.env.SUPERCOMPRESS_OPENAI_BASE || "https://api.openai.com/v1";
const ANTHROPIC_BASE = process.env.SUPERCOMPRESS_ANTHROPIC_BASE || "https://api.anthropic.com";

function extractBearer(authorization) {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function extractProviderKey(authorization, apiKeyHeader) {
  return extractBearer(authorization) || apiKeyHeader || null;
}

function parseProviderError(status, body) {
  try {
    const errJson = JSON.parse(body);
    return errJson.error?.message || errJson.error || body.slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}

function shouldFallbackResponses(status, body) {
  return (
    status === 401 ||
    (status === 403 &&
      /api\.responses\.write|responses.*scope|responses.*permission|missing scope/i.test(
        body || ""
      ))
  );
}

function setSSEHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
}

/**
 * Read a fetch body as decoded text, whichever stream flavour it is.
 *
 * Both flavours must carry an incomplete multi-byte sequence across chunk
 * boundaries and flush what is left when the stream ends: decoding each chunk
 * on its own turns a character split by a TCP boundary into U+FFFD.
 */
function readDecodedStream(body, { onText, onEnd, onError }) {
  // Node fetch body is a ReadableStream in undici, or a Node Readable if polyfilled.
  if (typeof body.getReader === "function") {
    const webReader = body.getReader();
    const decoder = new TextDecoder();
    (async () => {
      try {
        for (;;) {
          const { done, value } = await webReader.read();
          if (done) break;
          onText(decoder.decode(value, { stream: true }));
        }
        const tail = decoder.decode();
        if (tail) onText(tail);
        onEnd();
      } catch (err) {
        onError(err);
      }
    })();
    return;
  }

  const decoder = new StringDecoder("utf8");
  body.on("data", (chunk) => onText(decoder.write(chunk)));
  body.on("end", () => {
    const tail = decoder.end();
    if (tail) onText(tail);
    onEnd();
  });
  body.on("error", onError);
}

/**
 * Pipe an SSE body to res, buffering across TCP chunks.
 * Optional onEvent(parsed, rawLine) can rewrite a data payload.
 */
function pipeBufferedSSE(apiResponse, res, { onDataLine } = {}) {
  if (!apiResponse.body) throw new Error("Provider returned no response body stream");
  let buffer = "";
  readDecodedStream(apiResponse.body, {
    onText: (text) => {
      buffer = flushSSEBuffer(buffer + text, res, onDataLine);
    },
    onEnd: () => {
      if (buffer.trim()) flushSSEBuffer(buffer + "\n", res, onDataLine);
      res.end();
    },
    onError: (err) => {
      console.error("[supercompress] Stream error:", err.message);
      if (!res.writableEnded) res.end();
    },
  });
}

function flushSSEBuffer(buffer, res, onDataLine) {
  const lines = buffer.split("\n");
  const rest = lines.pop() || "";
  for (const line of lines) {
    if (onDataLine && line.startsWith("data: ") && line !== "data: [DONE]") {
      try {
        const parsed = JSON.parse(line.slice(6));
        const rewritten = onDataLine(parsed, line);
        if (rewritten == null) continue;
        res.write(typeof rewritten === "string" ? rewritten : `data: ${JSON.stringify(rewritten)}\n\n`);
        continue;
      } catch {
        // Incomplete JSON mid-buffer shouldn't reach here (we only flush full lines).
        // If a single line is corrupt, forward raw so we don't drop the stream.
        res.write(line + "\n");
        continue;
      }
    }
    res.write(line + "\n");
  }
  return rest;
}

/**
 * Forward to OpenAI chat completions — supports streaming.
 */
async function forwardChat(model, compressed, extraParams, res, authHeader) {
  const apiKey = extractBearer(authHeader);
  if (!apiKey) {
    throw new Error(
      "No provider API key found in Authorization header. Login-only subscription sessions are not supported by this local proxy; use the provider's API-key mode."
    );
  }

  const isStream = extraParams.stream === true || extraParams.stream === "true";
  const body = {
    model,
    messages: compressed.messages,
    ...extraParams,
    stream: isStream,
  };

  const scMeta = {
    _supercompress: {
      original_tokens: compressed.original_tokens,
      compressed_tokens: compressed.compressed_tokens,
      tokens_saved: compressed.tokens_saved,
      savings_pct: compressed.savings_pct,
    },
  };

  if (isStream) {
    setSSEHeaders(res);
    const apiResponse = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!apiResponse.ok) {
      const errorBody = await apiResponse.text().catch(() => "");
      const msg = parseProviderError(apiResponse.status, errorBody);
      res.write(`data: ${JSON.stringify({ error: { message: msg, type: "provider_error" } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    let firstChunkSent = false;
    pipeBufferedSSE(apiResponse, res, {
      onDataLine: (parsed) => {
        if (!firstChunkSent) {
          firstChunkSent = true;
          return { ...parsed, ...scMeta };
        }
        return parsed;
      },
    });
    return;
  }

  const apiResponse = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!apiResponse.ok) {
    const errorBody = await apiResponse.text().catch(() => "");
    throw new Error(
      `Provider error (${apiResponse.status}): ${parseProviderError(apiResponse.status, errorBody)}`
    );
  }

  const data = await apiResponse.json();
  res.json({ ...data, ...scMeta });
}

function anthropicSSE(eventType, data) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function forwardAnthropic(model, compressed, system, extraParams, res, authHeader, apiKeyHeader) {
  const apiKey = extractProviderKey(authHeader, apiKeyHeader);
  if (!apiKey) {
    throw new Error(
      "No provider API key found in Authorization header. Login-only subscription sessions are not supported by this local proxy; use the provider's API-key mode."
    );
  }

  const isStream = extraParams.stream === true || extraParams.stream === "true";
  const compressedMessages = compressed.messages || [];

  let systemContent = system || "";
  const userMessages = [];

  for (const msg of compressedMessages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      systemContent = systemContent ? `${systemContent}\n\n${text}` : text;
    } else if (msg.role === "user" || msg.role === "assistant") {
      userMessages.push({ role: msg.role, content: msg.content });
    } else if (msg.role === "tool") {
      // Anthropic tool results need native shape — if present, protocol skip should have fired.
      userMessages.push({ role: "user", content: messageContentAsText(msg.content) });
    }
  }

  const body = {
    model,
    messages: userMessages.length > 0 ? userMessages : [{ role: "user", content: "Continue." }],
    ...extraParams,
  };
  if (systemContent) body.system = systemContent;

  const apiResponse = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!apiResponse.ok) {
    const errorBody = await apiResponse.text().catch(() => "");
    throw new Error(
      `Anthropic error (${apiResponse.status}): ${parseProviderError(apiResponse.status, errorBody)}`
    );
  }

  if (isStream) {
    setSSEHeaders(res);
    res.write(
      anthropicSSE("supercompress", {
        original_tokens: compressed.original_tokens,
        compressed_tokens: compressed.compressed_tokens,
        tokens_saved: compressed.tokens_saved,
        savings_pct: compressed.savings_pct,
      })
    );
    pipeBufferedSSE(apiResponse, res);
    return;
  }

  const data = await apiResponse.json();
  res.json({
    id: data.id,
    type: "message",
    role: "assistant",
    content: data.content,
    model: data.model,
    stop_reason: data.stop_reason,
    stop_sequence: data.stop_sequence,
    usage: data.usage,
    _supercompress: {
      original_tokens: compressed.original_tokens,
      compressed_tokens: compressed.compressed_tokens,
      tokens_saved: compressed.tokens_saved,
      savings_pct: compressed.savings_pct,
    },
  });
}

function messageContentAsText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      return part?.text || part?.content || part?.input_text || part?.output_text || "";
    })
    .filter(Boolean)
    .join("\n");
}

function responseContentToText(content) {
  return messageContentAsText(content);
}

/** Typed Responses items that must not be flattened. */
function responsesInputHasStructuredItems(input) {
  if (!Array.isArray(input)) return false;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type || "");
    if (
      type === "function_call" ||
      type === "function_call_output" ||
      type === "tool_call" ||
      type === "tool_result" ||
      type === "custom_tool_call" ||
      type === "custom_tool_call_output" ||
      type === "reasoning" ||
      item.call_id ||
      item.tool_call_id
    ) {
      return true;
    }
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        const t = String(part?.type || "");
        if (t && t !== "input_text" && t !== "output_text" && t !== "text") return true;
      }
    }
  }
  return false;
}

/**
 * Convert Responses input → chat messages for compression of plain text turns only.
 * Structured items are not supported here — caller must skip compression.
 */
function responsesInputToMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [{ role: "user", content: JSON.stringify(input) }];

  const messages = [];
  for (const item of input.filter(Boolean)) {
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }
    const type = String(item.type || "");
    if (type === "message" || item.role) {
      messages.push({
        role: item.role || "user",
        content: responseContentToText(item.content ?? item.text ?? item),
      });
      continue;
    }
    // Preserve opaque structured items as JSON user blobs only when forced —
    // prefer skip via responsesInputHasStructuredItems.
    messages.push({
      role: "user",
      content: JSON.stringify(item),
    });
  }
  return messages.length ? messages : [{ role: "user", content: "" }];
}

function messagesToResponsesInput(messages) {
  return (messages || []).map((message) => ({
    role: message.role === "system" ? "developer" : message.role,
    content: responseContentToText(message.content),
  }));
}

function responsesToChatBody(model, compressed, extraParams, isStream) {
  const messages = messagesToResponsesInput(compressed.messages);
  const instructions = responseContentToText(extraParams.instructions);
  if (instructions) messages.unshift({ role: "system", content: instructions });

  const body = {
    model,
    messages,
    stream: isStream,
  };

  for (const key of [
    "temperature",
    "top_p",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "user",
    "metadata",
    "store",
  ]) {
    if (extraParams[key] !== undefined) body[key] = extraParams[key];
  }
  if (extraParams.max_output_tokens !== undefined) body.max_tokens = extraParams.max_output_tokens;
  if (extraParams.max_tokens !== undefined) body.max_tokens = extraParams.max_tokens;
  return body;
}

function responsesFallbackObject(data, model) {
  const message = data.choices?.[0]?.message || { role: "assistant", content: "" };
  const text = responseContentToText(message.content);
  const output = [
    {
      id: `msg_${Date.now().toString(36)}`,
      type: "message",
      status: "completed",
      role: message.role || "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    },
  ];
  return {
    id: data.id || `resp_${Date.now().toString(36)}`,
    object: "response",
    created_at: data.created || Math.floor(Date.now() / 1000),
    status: "completed",
    model: data.model || model,
    output,
    output_text: text,
    usage: data.usage || null,
  };
}

async function forwardResponsesViaChatFixed(
  model,
  compressed,
  extraParams,
  res,
  apiKey,
  providerError,
  originalInput
) {
  const isStream = extraParams.stream === true || extraParams.stream === "true";
  const emptyCompressed = !compressed.messages || compressed.messages.length === 0;
  const preferOriginal =
    originalInput !== undefined &&
    (compressed.skip_reason === "structured_protocol" || emptyCompressed);
  if (preferOriginal && responsesInputHasStructuredItems(originalInput)) {
    throw new Error(
      "OpenAI Responses API unavailable, and this request has structured tool items that cannot use the Chat Completions fallback. Enable Responses access for this key."
    );
  }
  if (emptyCompressed && !preferOriginal) {
    throw new Error(
      "OpenAI Responses Chat Completions fallback received empty messages (structured compression skip). Enable Responses access for this key."
    );
  }
  const body = responsesToChatBody(
    model,
    preferOriginal
      ? { ...compressed, messages: responsesInputToMessages(originalInput) }
      : compressed,
    extraParams,
    isStream
  );
  console.error(
    `[supercompress] Responses permission unavailable; using Chat Completions compatibility fallback (${providerError.slice(0, 160)})`
  );

  const apiResponse = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!apiResponse.ok) {
    const errorBody = await apiResponse.text().catch(() => "");
    throw new Error(
      `OpenAI Chat Completions fallback error (${apiResponse.status}): ${parseProviderError(apiResponse.status, errorBody)}`
    );
  }

  if (!isStream) {
    const data = await apiResponse.json();
    res.json({
      ...responsesFallbackObject(data, model),
      _supercompress: {
        original_tokens: compressed.original_tokens,
        compressed_tokens: compressed.compressed_tokens,
        tokens_saved: compressed.tokens_saved,
        savings_pct: compressed.savings_pct,
      },
    });
    return;
  }

  setSSEHeaders(res);
  const responseId = `resp_${Date.now().toString(36)}`;
  const messageId = `msg_${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const writeEvent = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  writeEvent("response.created", {
    type: "response.created",
    response: { id: responseId, object: "response", status: "in_progress", model },
  });
  writeEvent("response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: { id: messageId, type: "message", status: "in_progress", role: "assistant", content: [] },
  });
  writeEvent("response.content_part.added", {
    type: "response.content_part.added",
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });

  let fullText = "";
  let buffer = "";
  const reader = apiResponse.body;
  const onChunk = (text) => {
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      try {
        const parsed = JSON.parse(line.slice(6));
        const delta = parsed.choices?.[0]?.delta?.content || "";
        if (!delta) continue;
        fullText += delta;
        writeEvent("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta,
          sequence_number: fullText.length,
        });
      } catch {}
    }
  };
  const onEnd = () => {
    writeEvent("response.output_text.done", {
      type: "response.output_text.done",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text: fullText,
    });
    writeEvent("response.content_part.done", {
      type: "response.content_part.done",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: fullText, annotations: [] },
    });
    writeEvent("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: messageId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: fullText, annotations: [] }],
      },
    });
    writeEvent("response.completed", {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        created_at: created,
        model,
        output_text: fullText,
      },
    });
    res.end();
  };

  readDecodedStream(reader, {
    onText: onChunk,
    onEnd,
    onError: (err) => {
      console.error("[supercompress] Responses compatibility stream error:", err.message);
      if (!res.writableEnded) res.end();
    },
  });
}

async function forwardResponses(model, compressed, extraParams, res, authHeader, originalInput) {
  const apiKey = extractBearer(authHeader);
  if (!apiKey) {
    throw new Error(
      "No provider API key found in Authorization header. Login-only subscription sessions are not supported by this local proxy; use the provider's API-key mode."
    );
  }

  const isStream = extraParams.stream === true || extraParams.stream === "true";
  // When compression was skipped for structured protocol, forward original input.
  const useOriginal =
    compressed.skip_reason === "structured_protocol" && originalInput !== undefined;
  const body = {
    ...extraParams,
    model,
    input: useOriginal ? originalInput : messagesToResponsesInput(compressed.messages),
    stream: isStream,
  };
  const apiResponse = await fetch(`${OPENAI_BASE}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!apiResponse.ok) {
    const errorBody = await apiResponse.text().catch(() => "");
    if (shouldFallbackResponses(apiResponse.status, errorBody)) {
      await forwardResponsesViaChatFixed(
        model,
        compressed,
        extraParams,
        res,
        apiKey,
        parseProviderError(apiResponse.status, errorBody),
        originalInput
      );
      return;
    }
    throw new Error(
      `OpenAI Responses error (${apiResponse.status}): ${parseProviderError(apiResponse.status, errorBody)}`
    );
  }

  if (isStream) {
    setSSEHeaders(res);
    pipeBufferedSSE(apiResponse, res);
    return;
  }

  const data = await apiResponse.json();
  res.json({
    ...data,
    _supercompress: {
      original_tokens: compressed.original_tokens,
      compressed_tokens: compressed.compressed_tokens,
      tokens_saved: compressed.tokens_saved,
      savings_pct: compressed.savings_pct,
    },
  });
}

module.exports = {
  readDecodedStream,
  pipeBufferedSSE,
  forwardChat,
  forwardAnthropic,
  forwardResponses,
  responsesInputToMessages,
  responsesInputHasStructuredItems,
  extractBearer,
};
