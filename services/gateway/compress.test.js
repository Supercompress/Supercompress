"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createCompressFn, applyCompressedToMessages } = require("./compress");

describe("gateway compress in-path", () => {
  it("never puts ask on compression trace; keeps user message", async () => {
    const compress = createCompressFn({
      neuralKeep: async () => null,
    });
    const ask = "what is the secret passphrase?";
    const ctx = {
      user_ask: ask,
      context: "big context ".repeat(40),
      normalized: {
        messages: [
          { role: "system", content: "big context ".repeat(40) },
          { role: "user", content: ask },
        ],
      },
    };
    await compress(ctx);
    assert.equal(ctx.compression.strategy, "compiler");
    assert.ok(ctx.compression.retained_tokens < ctx.compression.original_tokens);
    assert.equal(ctx.compression.query, undefined);
    assert.ok(!JSON.stringify(ctx.compression).includes("passphrase"));
    const user = ctx.normalized.messages.find((m) => m.role === "user");
    assert.equal(user.content, ask);
    const system = ctx.normalized.messages.find((m) => m.role === "system");
    assert.ok(system.content.length < "big context ".repeat(40).length);
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
      context: "lots of stuff",
      normalized: {
        messages: [
          { role: "system", content: "lots of stuff" },
          { role: "user", content: "q" },
        ],
      },
    };
    await compress(ctx);
    assert.equal(ctx.compression.strategy, "neural_keep");
    assert.equal(ctx.compression.retained_tokens, 10);
    assert.equal(ctx.context, "kept bits");
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
