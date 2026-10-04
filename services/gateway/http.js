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

function openaiStreamChunk({ id, model, content, finish }) {
  return {
    id: id || "chatcmpl_stream",
    object: "chat.completion.chunk",
    model: model || "unknown",
    choices: [
      {
        index: 0,
        delta: finish ? {} : { content: content || "" },
        finish_reason: finish || null,
      },
    ],
  };
}

/**
 * Write OpenAI-compatible SSE to a Node ServerResponse from ctx.stream.
 * Assumes pipeline already ran through stream stage (pass-through iterator ready).
 */
async function writeOpenAiSse(res, ctx) {
  const id = ctx.openai?.id || `chatcmpl_${ctx.request_id || "x"}`;
  const model = ctx.model_routed || ctx.openai?.model || "unknown";
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  if (ctx.aborted) {
    res.statusCode = ctx.error?.status && ctx.error.status < 600 ? ctx.error.status : 502;
    res.end(
      sseData({
        error: {
          message: ctx.error?.message || "aborted",
          type: "gateway_error",
        },
      })
    );
    return;
  }

  res.statusCode = 200;
  const stream = ctx.stream;
  if (stream && typeof stream[Symbol.asyncIterator] === "function") {
    for await (const piece of stream) {
      if (!piece) continue;
      res.write(sseData(openaiStreamChunk({ id, model, content: piece })));
      if (typeof res.flush === "function") res.flush();
    }
  } else {
    const text =
      typeof ctx.provider_result?.output === "string"
        ? ctx.provider_result.output
        : ctx.provider_result?.output?.content || "";
    if (text) res.write(sseData(openaiStreamChunk({ id, model, content: text })));
  }
  res.write(sseData(openaiStreamChunk({ id, model, finish: "stop" })));
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * Singleton gateway for warm lambdas — rebuilt when options fingerprint changes.
 */
let _gw = null;
let _gwKey = "";

function getProcessGateway(options = {}) {
  const seedRaw = options.seedBalance ?? process.env.SC_CP_WALLET_SEED ?? "100";
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
      defaultBalance: Number(seedRaw) || 100,
      pool: options.pool,
    });
  _gw = createWiredGateway({
    allowStubFallback: options.allowStubFallback !== false,
    deferStreamFinalize: true,
    ...options,
    store,
    seedBalance: Number(seedRaw) || 100,
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
