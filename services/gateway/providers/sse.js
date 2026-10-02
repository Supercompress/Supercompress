"use strict";

/**
 * Minimal SSE helpers for provider adapters (no deps).
 */

/**
 * Parse an SSE text buffer into { event, data } records.
 * @param {string} chunk
 * @returns {{ event: string, data: string }[]}
 */
function parseSseBlock(chunk) {
  const records = [];
  const blocks = String(chunk || "").split(/\n\n+/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = "message";
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length) records.push({ event, data: dataLines.join("\n") });
  }
  return records;
}

/**
 * Read a fetch Response body as an async iterable of SSE data strings
 * (the `data:` payload only; skips [DONE]).
 * @param {Response} res
 * @returns {AsyncGenerator<string>}
 */
async function* iterateSseData(res) {
  if (!res.body || typeof res.body.getReader !== "function") {
    const text = await res.text();
    for (const rec of parseSseBlock(text)) {
      if (rec.data === "[DONE]") return;
      yield rec.data;
    }
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const rec of parseSseBlock(block)) {
        if (rec.data === "[DONE]") return;
        yield rec.data;
      }
    }
  }
  if (buf.trim()) {
    for (const rec of parseSseBlock(buf)) {
      if (rec.data === "[DONE]") return;
      yield rec.data;
    }
  }
}

/**
 * Collect text deltas from an async iterable of string chunks.
 */
async function collectText(asyncIterable) {
  let text = "";
  for await (const chunk of asyncIterable) {
    text += chunk;
  }
  return text;
}

/**
 * Incremental SSE consumer for tests / partial buffers.
 * @param {string} chunk
 * @param {{ buf?: string }} [state]
 * @returns {string[]} data payloads (includes "[DONE]" when present)
 */
function consumeSse(chunk, state = {}) {
  state.buf = (state.buf || "") + String(chunk || "");
  const out = [];
  let idx;
  while ((idx = state.buf.indexOf("\n\n")) !== -1) {
    const block = state.buf.slice(0, idx);
    state.buf = state.buf.slice(idx + 2);
    for (const rec of parseSseBlock(block)) {
      out.push(rec.data);
    }
  }
  // Trailing incomplete block without blank line — still emit complete data: lines
  if (state.buf.includes("data:") && !state.buf.includes("\n\n")) {
    const maybe = state.buf;
    if (maybe.endsWith("\n") || /\[DONE\]/.test(maybe)) {
      for (const rec of parseSseBlock(maybe)) {
        out.push(rec.data);
      }
      state.buf = "";
    }
  }
  return out;
}

function providerError(message, status, bodyOrCode) {
  const err = new Error(message);
  err.status = status;
  if (bodyOrCode != null && typeof bodyOrCode === "object") {
    err.body = bodyOrCode;
    err.code = "provider_error";
  } else {
    err.code = bodyOrCode || "provider_error";
  }
  return err;
}

module.exports = {
  parseSseBlock,
  iterateSseData,
  consumeSse,
  collectText,
  providerError,
};
