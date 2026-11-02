"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createCompressFn, applyCompressedToMessages, eligibleBlocks } = require("./compress");

const BULK = Array.from({ length: 120 }, (_, i) => `line ${i}: build output for module ${i} ok`).join("\n");

describe("gateway compress in-path", () => {
  it("never puts ask on compression trace; keeps user message and system prompt", async () => {
    const compress = createCompressFn({
      neuralKeep: async () => null,
      heuristicFallback: true,
    });
    const ask = "what is the secret passphrase?";
    const system = "You are a careful assistant. ".repeat(100);
    const ctx = {
      user_ask: ask,
      normalized: {
        messages: [
          { role: "system", content: system },
          { role: "user", content: "check the build" },
          { role: "tool", tool_call_id: "t1", content: BULK },
          { role: "user", content: ask },
        ],
      },
    };
    await compress(ctx);
    assert.equal(ctx.compression.strategy, "compiler");
    assert.ok(ctx.compression.retained_tokens < ctx.compression.original_tokens);
    assert.equal(ctx.compression.query, undefined);
    assert.ok(!JSON.stringify(ctx.compression).includes("passphrase"));
    const msgs = ctx.normalized.messages;
    assert.equal(msgs[0].content, system, "system prompt is not rewritten by default");
    assert.equal(msgs[3].content, ask);
    assert.ok(msgs[2].content.length < BULK.length);
  });

  it("uses Neural Keep when injectable returns result", async () => {
    const compress = createCompressFn({
      neuralKeep: async () => ({
        compressed_text: "kept bits",
        original_tokens: 100,
        kept_tokens: 10,
        neural_keep_latency_ms: 12,
      }),
    });
    const ctx = {
      user_ask: "q",
      normalized: {
        messages: [
          { role: "tool", tool_call_id: "t1", content: BULK },
          { role: "user", content: "q" },
        ],
      },
    };
    await compress(ctx);
    assert.equal(ctx.compression.strategy, "neural_keep");
    assert.equal(ctx.compression.retained_tokens, 10);
    assert.equal(ctx.normalized.messages[0].content, "kept bits");
  });

  it("skips (no toy heuristic) when no compressor is available", async () => {
    const compress = createCompressFn({ neuralKeep: async () => null });
    const ctx = {
      user_ask: "q",
      normalized: {
        messages: [
          { role: "tool", tool_call_id: "t1", content: BULK },
          { role: "user", content: "q" },
        ],
      },
    };
    await compress(ctx);
    assert.equal(ctx.compression.strategy, "skip");
    assert.equal(ctx.normalized.messages[0].content, BULK);
  });

  it("eligibleBlocks: tool results and earlier turns, never the ask or system by default", () => {
    const msgs = [
      { role: "system", content: BULK },
      { role: "user", content: BULK },
      { role: "assistant", content: BULK },
      { role: "tool", content: BULK },
      { role: "user", content: BULK },
    ];
    assert.deepEqual(
      eligibleBlocks(msgs).map((b) => b.index).sort(),
      [1, 2, 3]
    );
    assert.ok(eligibleBlocks(msgs, { includeSystem: true }).some((b) => b.index === 0));
  });

  it("applyCompressedToMessages preserves ask", () => {
    const n = applyCompressedToMessages(
      {
        messages: [
          { role: "system", content: "old" },
          { role: "user", content: "ask" },
        ],
      },
      "new"
    );
    assert.equal(n.messages[0].content, "new");
    assert.equal(n.messages[1].content, "ask");
  });
});
