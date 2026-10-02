"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const {
  isGatewayEnabled,
  sseData,
  openaiStreamChunk,
  writeOpenAiSse,
} = require("./http");
const { createWiredGateway } = require("./wire");

describe("gateway http helpers", () => {
  const orig = { ...process.env };
  afterEach(() => {
    process.env = { ...orig };
  });

  it("isGatewayEnabled respects SC_CP_GATEWAY", () => {
    delete process.env.SC_CP_GATEWAY;
    assert.equal(isGatewayEnabled(), false);
    process.env.SC_CP_GATEWAY = "1";
    // flags() reads env live
    assert.equal(isGatewayEnabled(), true);
  });

  it("formats sse + openai chunks", () => {
    assert.match(sseData({ a: 1 }), /^data: /);
    const c = openaiStreamChunk({ id: "1", model: "m", content: "hi" });
    assert.equal(c.choices[0].delta.content, "hi");
  });
});

describe("first-class stream passthrough", () => {
  it("yields provider chunks before full drain", async () => {
    async function* slow() {
      yield "hel";
      yield "lo";
    }
    const gw = createWiredGateway({
      seedBalance: 20,
      estimated_max_usd: 1,
      enableRouting: false,
      enableLedger: false,
      enforceReserve: false,
      // Keep stream open so HTTP/SSE can read chunks live.
      deferStreamFinalize: true,
      provider: async (ctx) => {
        ctx.provider_result = {
          model: "stub-model",
          provider: "stub",
          stream: slow(),
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        return ctx;
      },
    });
    const ctx = await gw.handleChatCompletions(
      {
        model: "stub-model",
        stream: true,
        messages: [
          { role: "system", content: "ctx" },
          { role: "user", content: "hi" },
        ],
        idempotency_key: "stream-1",
      },
      { key_id: "k1" }
    );
    assert.equal(ctx.aborted, false);
    assert.equal(ctx._deferred_finalize, true);
    assert.ok(ctx.stream);
    const seen = [];
    for await (const p of ctx.stream) seen.push(p);
    assert.deepEqual(seen, ["hel", "lo"]);
    assert.equal(ctx.provider_result.output.content, "hello");
    await gw.finalizeDeferred(ctx);
    assert.equal(ctx._deferred_finalize, false);
  });

  it("writeOpenAiSse emits data frames + DONE", async () => {
    const chunks = [];
    const res = new EventEmitter();
    res.statusCode = 0;
    res.headers = {};
    res.setHeader = (k, v) => {
      res.headers[k] = v;
    };
    res.write = (s) => {
      chunks.push(String(s));
      return true;
    };
    res.end = (s) => {
      if (s) chunks.push(String(s));
      res.ended = true;
    };
    res.flushHeaders = () => {};

    await writeOpenAiSse(res, {
      aborted: false,
      model_routed: "gpt-4o-mini",
      request_id: "req_test",
      stream: (async function* () {
        yield "A";
        yield "B";
      })(),
    });
    const joined = chunks.join("");
    assert.match(joined, /data: /);
    assert.match(joined, /"content":"A"/);
    assert.match(joined, /\[DONE\]/);
    assert.equal(res.statusCode, 200);
  });
});
