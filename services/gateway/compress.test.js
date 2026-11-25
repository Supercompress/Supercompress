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

  it("compresses large text parts of array contents and leaves images and the caller's request alone", async () => {
    const compress = createCompressFn({
      neuralKeep: async () => ({ compressed_text: "kept bits", original_tokens: 100, kept_tokens: 10 }),
    });
    const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
    const original = [
      { role: "user", content: [{ type: "text", text: "short note" }, { type: "text", text: BULK }, image] },
      { role: "user", content: [{ type: "text", text: BULK }] },
    ];
    const ctx = { user_ask: "q", normalized: { messages: original } };
    await compress(ctx);
    const [first, ask] = ctx.normalized.messages;
    assert.equal(ctx.compression.strategy, "neural_keep");
    assert.deepEqual(first.content, [{ type: "text", text: "short note" }, { type: "text", text: "kept bits" }, image]);
    assert.equal(ask.content[0].text, BULK, "the latest user message is the ask");
    assert.equal(original[0].content[1].text, BULK, "input messages are not mutated");
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

describe("gateway default compressor", () => {
  it("uses the Fast engine and labels it fast", async () => {
    const { createDefaultCompressFn } = require("./compress");
    const previous = process.env.SC_COMPRESS_ENGINE;
    delete process.env.SC_COMPRESS_ENGINE;
    try {
      const log = [
        ...Array.from({ length: 300 }, (_, i) => `PASS src/module${i}.test.js (${(i * 37) % 900} ms)`),
        "FAIL src/auth/session.test.js",
        "  ● createSession › times out after AUTH_TIMEOUT_MS",
        "    Expected: 45000",
        "    Received: 30000",
        "      at Object.<anonymous> (src/auth/session.test.js:42:18)",
        "Tests: 1 failed, 300 passed, 301 total",
      ].join("\n");
      const ctx = {
        user_ask: "Why does the session test fail?",
        normalized: {
          messages: [
            { role: "tool", tool_call_id: "t1", content: log },
            { role: "user", content: "Why does the session test fail?" },
          ],
        },
      };
      await createDefaultCompressFn()(ctx);
      assert.equal(ctx.compression.strategy, "fast");
      assert.ok(ctx.compression.retained_tokens < ctx.compression.original_tokens);
      assert.ok(ctx.normalized.messages[0].content.includes("Received: 30000"));
    } finally {
      if (previous === undefined) delete process.env.SC_COMPRESS_ENGINE;
      else process.env.SC_COMPRESS_ENGINE = previous;
    }
  });

  it("records the engine's passthrough reason instead of calling the compressor unavailable", async () => {
    const { createDefaultCompressFn } = require("./compress");
    const previous = process.env.SC_COMPRESS_ENGINE;
    delete process.env.SC_COMPRESS_ENGINE;
    try {
      const log = Array.from({ length: 400 }, (_, i) => `row ${i}: status=ok latency_ms=${(i * 37) % 900} region=us-${i % 5}`).join("\n") +
        "\nrow 9999: status=FAILED region=eu-1";
      const ctx = {
        user_ask: "Which row has status FAILED?",
        normalized: { messages: [{ role: "tool", tool_call_id: "t1", content: log }, { role: "user", content: "Which row has status FAILED?" }] },
      };
      await createDefaultCompressFn()(ctx);
      assert.equal(ctx.compression.strategy, "skip");
      assert.equal(ctx.compression.skip_reason, "suspicious_compression_collapse");
      assert.equal(ctx.normalized.messages[0].content, log);
    } finally {
      if (previous === undefined) delete process.env.SC_COMPRESS_ENGINE;
      else process.env.SC_COMPRESS_ENGINE = previous;
    }
  });
});
