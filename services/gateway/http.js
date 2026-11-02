"use strict";

/**
 * Unadvertised HTTP edge helpers for the control-plane gateway.
 * Enable only when SC_CP_GATEWAY=1 (isGatewayEnabled).
 */

const { createWiredGateway } = require("./wire");
const { flags, createStoreFromEnv } = require("../../packages/control-plane");

function isGatewayEnabled() {
  return flags().gateway;
}

function sseData(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function openaiStreamChunk({ id, model, created, content, delta, finish }) {
  return {
    id: id || "chatcmpl_stream",
    object: "chat.completion.chunk",
    created: created || Math.floor(Date.now() / 1000),
    model: model || "unknown",
    choices: [
      {
        index: 0,
        delta: delta || (finish ? {} : { content: content || "" }),
        finish_reason: finish || null,
      },
    ],
  };
}

/**
 * Write OpenAI-compatible SSE to a Node ServerResponse from ctx.stream.
 * Assumes pipeline already ran through stream stage (pass-through iterator ready).
 * First chunk carries delta.role; tool-call deltas pass through; the final chunk carries the
 * upstream finish_reason. A stream that fails mid-way ends with an error event, not "stop".
 */
async function writeOpenAiSse(res, ctx) {
  const id = ctx.openai?.id || `chatcmpl-${ctx.request_id || "x"}`;
  const model = ctx.model_routed || ctx.openai?.model || "unknown";
  const created = Math.floor((ctx.started_at_ms || Date.now()) / 1000);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  if (ctx.aborted) {
    res.statusCode = ctx.error?.status && ctx.error.status < 600 ? ctx.error.status : 502;
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    res.end(
      sseData({
        error: {
          message: ctx.error?.message || "aborted",
          type: "server_error",
        },
      })
    );
    return;
  }

  res.statusCode = 200;
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  const send = (obj) => {
    res.write(sseData(obj));
    if (typeof res.flush === "function") res.flush();
  };
  send(openaiStreamChunk({ id, model, created, delta: { role: "assistant", content: "" } }));

  const stream = ctx.stream;
  let sawToolCalls = false;
  try {
    if (stream && typeof stream[Symbol.asyncIterator] === "function") {
      for await (const raw of stream) {
        if (!raw) continue;
        const piece = typeof raw === "string" ? { content: raw } : raw;
        const delta = {};
        if (piece.content) delta.content = piece.content;
        if (piece.tool_calls) {
          delta.tool_calls = piece.tool_calls;
          sawToolCalls = true;
        }
        if (delta.content || delta.tool_calls) send(openaiStreamChunk({ id, model, created, delta }));
      }
    } else {
      const text =
        typeof ctx.provider_result?.output === "string"
          ? ctx.provider_result.output
          : ctx.provider_result?.output?.content || "";
      if (text) send(openaiStreamChunk({ id, model, created, content: text }));
    }
  } catch (err) {
    send({
      error: {
        message: err?.code === "upstream_timeout" ? "upstream_timeout" : "upstream_stream_error",
        type: "server_error",
      },
    });
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  const finish = ctx.provider_result?.finish_reason || (sawToolCalls ? "tool_calls" : "stop");
  send(openaiStreamChunk({ id, model, created, finish }));
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * Singleton gateway for warm lambdas — rebuilt when options fingerprint changes.
 */
let _gw = null;
let _gwKey = "";

function getProcessGateway(options = {}) {
  const prod = process.env.NODE_ENV === "production";
  // No free money in production: wallets start at 0 unless an operator seeds them.
  const seedRaw = options.seedBalance ?? process.env.SC_CP_WALLET_SEED ?? (prod ? "0" : "100");
  const key = JSON.stringify({
    durableDir: options.durableDir || process.env.SC_CP_DURABLE_DIR || "",
    db: process.env.SC_CP_DATABASE_URL || process.env.DATABASE_URL || "",
    seed: String(seedRaw),
    defer: true,
  });
  if (_gw && _gwKey === key) return _gw;
  _gwKey = key;
  const store =
    options.store ||
    createStoreFromEnv({
      durableDir: options.durableDir,
      defaultBalance: Number(seedRaw) || 0,
      pool: options.pool,
    });
  _gw = createWiredGateway({
    deferStreamFinalize: true,
    ...options,
    store,
    seedBalance: Number(seedRaw) || 0,
  });
  return _gw;
}

module.exports = {
  isGatewayEnabled,
  sseData,
  openaiStreamChunk,
  writeOpenAiSse,
  getProcessGateway,
};
