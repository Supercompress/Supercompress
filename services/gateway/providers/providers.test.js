"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createOpenAIProvider, buildOpenAIBody } = require("./openai");
const { createAnthropicProvider, buildAnthropicBody } = require("./anthropic");
const { createProvider } = require("./index");
const { consumeSse } = require("./sse");
const { normalizeCatalog, defaultCatalog } = require("../../../packages/control-plane");

function mockFetchSequence(handlers) {
  let i = 0;
  return async (url, init) => {
    const h = handlers[i++];
    if (!h) throw new Error(`unexpected fetch #${i} to ${url}`);
    return h(url, init);
  };
}

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return obj;
    },
    async text() {
      return JSON.stringify(obj);
    },
    body: null,
  };
}

function sseResponse(events, status = 200) {
  const text = events.map((e) => `data: ${e}\n\n`).join("") + "data: [DONE]\n\n";
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    },
    body: {
      getReader() {
        const enc = new TextEncoder();
        let done = false;
        return {
          async read() {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: enc.encode(text) };
          },
        };
      },
    },
  };
}

describe("sse helper", () => {
  it("parses data lines", () => {
    const state = {};
    const parts = consumeSse('data: {"a":1}\n\ndata: [DONE]\n\n', state);
    assert.equal(parts[0], '{"a":1}');
    assert.equal(parts[1], "[DONE]");
  });
});

describe("openai adapter", () => {
  it("builds chat body from normalized request", () => {
    const body = buildOpenAIBody({
      model_routed: "gpt-4o-mini",
      normalized: {
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        temperature: 0.2,
      },
    });
    assert.equal(body.model, "gpt-4o-mini");
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
  });

  it("non-stream 200", async () => {
    const call = createOpenAIProvider({
      apiKey: "sk-test",
      fetchImpl: mockFetchSequence([
        () =>
          jsonResponse({
            model: "gpt-4o-mini",
            choices: [{ message: { content: "hello" } }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          }),
      ]),
    });
    const ctx = {
      model_routed: "gpt-4o-mini",
      normalized: { messages: [{ role: "user", content: "hi" }], stream: false },
    };
    await call(ctx);
    assert.equal(ctx.provider_result.output.content, "hello");
    assert.equal(ctx.provider_result.provider, "openai");
    assert.equal(ctx.provider_result.usage.output_tokens, 2);
  });

  it("streams SSE chunks", async () => {
    const call = createOpenAIProvider({
      apiKey: "sk-test",
      fetchImpl: mockFetchSequence([
        () =>
          sseResponse([
            JSON.stringify({ choices: [{ delta: { content: "hel" } }] }),
            JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
            JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 2 } }),
          ]),
      ]),
    });
    const ctx = {
      model_routed: "gpt-4o-mini",
      normalized: { messages: [{ role: "user", content: "hi" }], stream: true },
    };
    await call(ctx);
    const pieces = [];
    for await (const p of ctx.provider_result.stream) pieces.push(p);
    assert.equal(pieces.join(""), "hello");
    assert.equal(ctx.provider_result.output.content, "hello");
  });

  it("surfaces 429 with status", async () => {
    const call = createOpenAIProvider({
      apiKey: "sk-test",
      fetchImpl: mockFetchSequence([
        () => jsonResponse({ error: { message: "rate" } }, 429),
      ]),
    });
    await assert.rejects(
      () =>
        call({
          model_routed: "gpt-4o",
          normalized: { messages: [{ role: "user", content: "x" }] },
        }),
      (err) => err.status === 429
    );
  });
});

describe("anthropic adapter", () => {
  it("maps system + messages", () => {
    const body = buildAnthropicBody({
      model_routed: "claude-haiku-3.5",
      normalized: {
        messages: [
          { role: "system", content: "ctx" },
          { role: "user", content: "ask" },
        ],
        max_tokens: 64,
      },
    });
    assert.equal(body.system, "ctx");
    assert.equal(body.messages[0].role, "user");
    assert.equal(body.messages[0].content, "ask");
    assert.equal(body.max_tokens, 64);
  });

  it("non-stream 200", async () => {
    const call = createAnthropicProvider({
      apiKey: "ant-test",
      fetchImpl: mockFetchSequence([
        () =>
          jsonResponse({
            model: "claude-haiku-3.5",
            content: [{ type: "text", text: "yo" }],
            usage: { input_tokens: 4, output_tokens: 1 },
          }),
      ]),
    });
    const ctx = {
      model_routed: "claude-haiku-3.5",
      normalized: {
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "u" },
        ],
      },
    };
    await call(ctx);
    assert.equal(ctx.provider_result.output.content, "yo");
    assert.equal(ctx.provider_result.provider, "anthropic");
  });

  it("streams text deltas", async () => {
    const call = createAnthropicProvider({
      apiKey: "ant-test",
      fetchImpl: mockFetchSequence([
        () =>
          sseResponse([
            JSON.stringify({
              type: "message_start",
              message: { usage: { input_tokens: 2, output_tokens: 0 } },
            }),
            JSON.stringify({
              type: "content_block_delta",
              delta: { type: "text_delta", text: "ab" },
            }),
            JSON.stringify({
              type: "content_block_delta",
              delta: { type: "text_delta", text: "c" },
            }),
            JSON.stringify({
              type: "message_delta",
              usage: { output_tokens: 3 },
            }),
          ]),
      ]),
    });
    const ctx = {
      model_routed: "claude-sonnet-4",
      normalized: { messages: [{ role: "user", content: "hi" }], stream: true },
    };
    await call(ctx);
    const pieces = [];
    for await (const p of ctx.provider_result.stream) pieces.push(p);
    assert.equal(pieces.join(""), "abc");
    assert.equal(ctx.provider_result.usage.output_tokens, 3);
  });
});

describe("createProvider dispatch", () => {
  it("routes by catalog provider", async () => {
    const catalog = defaultCatalog();
    let saw = null;
    const provider = createProvider({
      catalog,
      allowStubFallback: false,
      requireLive: true,
      openaiApiKey: "sk",
      fetchImpl: async () => {
        saw = "openai";
        return jsonResponse({
          choices: [{ message: { content: "o" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      },
    });
    const ctx = await provider({
      model_routed: "gpt-4o-mini",
      normalized: { messages: [{ role: "user", content: "x" }] },
      compression: { retained_tokens: 1 },
    });
    assert.equal(saw, "openai");
    assert.equal(ctx.provider_result.provider, "openai");
  });

  it("falls back to stub when keys missing", async () => {
    delete process.env.OPENAI_API_KEY;
    const catalog = normalizeCatalog([
      { id: "gpt-4o-mini", provider: "openai", max_context_tokens: 8_000, input_usd_per_mtok: 0.1, output_usd_per_mtok: 0.1 },
    ]);
    const provider = createProvider({ catalog, allowStubFallback: true });
    const ctx = await provider({
      model_routed: "gpt-4o-mini",
      normalized: { messages: [{ role: "user", content: "x" }] },
      compression: { retained_tokens: 2 },
    });
    assert.equal(ctx.provider_result.provider, "stub");
  });
});
