"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  createPipeline,
  stubStages,
  STAGE_ORDER,
  fromChatCompletions,
  toChatCompletions,
  createWiredGateway,
  isGatewayEnabled,
} = require("./index");

/** Explicit CP primitives for tests — production flags default off. */
const CP_ON = { enableLedger: true, enforceReserve: true };

describe("gateway pipeline order", () => {
  it("executes stages in contract order", async () => {
    const pipe = createPipeline(stubStages());
    const ctx = await pipe.run({});
    assert.deepEqual(ctx.stages_executed, STAGE_ORDER);
  });

  it("adapters round-trip chat completions shape", () => {
    const n = fromChatCompletions({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "big context ".repeat(20) },
        { role: "user", content: "what is 2+2?" },
      ],
      sc_compress: true,
    }, { key_id: "k1" });
    assert.equal(n.model, "gpt-4o-mini");
    assert.equal(n.metadata.key_id, "k1");
    assert.equal(n.metadata.sc_compress, true);
    const out = toChatCompletions({
      id: "1",
      model: "gpt-4o-mini",
      output: { content: "4" },
      usage: { input_tokens: 10, output_tokens: 1 },
      request_id: "req_x",
    });
    assert.equal(out.choices[0].message.content, "4");
    assert.equal(out.sc_request_id, "req_x");
  });
});

describe("wired gateway phase 2", () => {
  it("happy path: reserve → compress → finalize", async () => {
    const gw = createWiredGateway({
      ...CP_ON,
      seedBalance: 50,
      estimated_max_usd: 2,
      policy: { version: 1, compress_default: true, max_usd_per_request: 5 },
    });
    const ctx = await gw.handleChatCompletions(
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "x".repeat(400) },
          { role: "user", content: "summarize" },
        ],
        idempotency_key: "wire-1",
      },
      { org_id: "o1", key_id: "k1", agent_id: "agent-a" }
    );
    assert.equal(ctx.aborted, false);
    assert.ok(ctx.request_id);
    assert.ok(ctx.compression);
    assert.equal(ctx.compression.strategy, "compiler");
    assert.ok(ctx.openai?.choices?.[0]?.message?.content);
    const rec = gw.ledger.get(ctx.request_id);
    assert.equal(rec.status, "finalized");
    assert.ok(rec.compression);
    assert.equal(ctx.stages_executed[0], "auth");
    assert.equal(ctx.stages_executed.at(-1), "finalize");
  });

  it("fail closed on insufficient reservation", async () => {
    const gw = createWiredGateway({
      ...CP_ON,
      seedBalance: 1,
      estimated_max_usd: 5,
      policy: { version: 1, compress_default: true, max_usd_per_request: 10 },
    });
    const ctx = await gw.handleChatCompletions(
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        idempotency_key: "wire-fail",
      },
      { key_id: "k1" }
    );
    assert.equal(ctx.aborted, true);
    assert.ok(ctx.request_id);
    assert.equal(gw.ledger.get(ctx.request_id).status, "finalized");
  });

  it("gateway flag defaults off", () => {
    delete process.env.SC_CP_GATEWAY;
    assert.equal(isGatewayEnabled(), false);
  });
});

describe("wired gateway phase 3 routing", () => {
  it("passthrough when routing disabled (flag default off)", async () => {
    delete process.env.SC_CP_ROUTE;
    const gw = createWiredGateway({
      ...CP_ON,
      seedBalance: 20,
      estimated_max_usd: 1,
      enableRouting: false,
      policy: { version: 1, compress_default: true },
    });
    const ctx = await gw.handleChatCompletions(
      {
        model: "gpt-4o",
        messages: [
          { role: "system", content: "ctx ".repeat(50) },
          { role: "user", content: "hi" },
        ],
        idempotency_key: "route-off",
      },
      { key_id: "k1", org_id: "o1" }
    );
    assert.equal(ctx.aborted, false);
    assert.equal(ctx.model_routed, "gpt-4o");
    assert.equal(ctx.route_decision.strategy, "passthrough");
  });

  it("cheapest_fit after compress prefers mini over 4o", async () => {
    const gw = createWiredGateway({
      ...CP_ON,
      seedBalance: 50,
      estimated_max_usd: 2,
      enableRouting: true,
      policy: {
        version: 1,
        compress_default: true,
        max_usd_per_request: 2,
        allow_models: ["gpt-4o", "gpt-4o-mini"],
        routing: { strategy: "cheapest_fit", fallbacks: ["gpt-4o-mini"], max_retries: 1 },
      },
    });
    const ctx = await gw.handleChatCompletions(
      {
        model: "gpt-4o",
        messages: [
          { role: "system", content: "x".repeat(800) },
          { role: "user", content: "what matters?" },
        ],
        idempotency_key: "route-cheap",
      },
      { key_id: "k1", org_id: "o1" }
    );
    assert.equal(ctx.aborted, false);
    assert.equal(ctx.model_routed, "gpt-4o-mini");
    assert.equal(ctx.route_decision.reason, "cheapest_fit");
    assert.ok(ctx.compression.model_eligibility.includes("gpt-4o-mini"));
    assert.equal(gw.ledger.get(ctx.request_id).model_routed, "gpt-4o-mini");
    // user ask must never be stored on compression trace
    assert.equal(ctx.compression.query, undefined);
    assert.ok(!JSON.stringify(ctx.compression).includes("what matters?"));
  });

  it("rejects when no model fits post-keep size", async () => {
    const gw = createWiredGateway({
      ...CP_ON,
      seedBalance: 50,
      estimated_max_usd: 1,
      enableRouting: true,
      catalog: [
        {
          id: "tiny",
          provider: "x",
          max_context_tokens: 50,
          input_usd_per_mtok: 0.01,
          output_usd_per_mtok: 0.01,
          capabilities: ["chat"],
        },
      ],
      policy: {
        version: 1,
        allow_models: ["tiny"],
        routing: { strategy: "fixed", output_tokens_reserve: 10 },
      },
      compress: (ctx) => {
        ctx.compress_result = {
          original_tokens: 5000,
          kept_tokens: 4000,
          tokens_saved: 1000,
          compressed: "x".repeat(100),
          engine: "stub",
        };
        ctx.compression = require("../../packages/control-plane").traceFromCompressResult(
          ctx.compress_result
        );
        return ctx;
      },
    });
    const ctx = await gw.handleChatCompletions(
      {
        model: "tiny",
        messages: [
          { role: "system", content: "big" },
          { role: "user", content: "ask" },
        ],
        idempotency_key: "route-nofit",
      },
      { key_id: "k1" }
    );
    assert.equal(ctx.aborted, true);
    assert.equal(ctx.error.message, "no_viable_model");
    assert.equal(gw.ledger.get(ctx.request_id).status, "finalized");
  });

  it("retries fallback on retryable provider error", async () => {
    let calls = 0;
    const gw = createWiredGateway({
      ...CP_ON,
      seedBalance: 50,
      estimated_max_usd: 2,
      enableRouting: true,
      policy: {
        version: 1,
        allow_models: ["gpt-4o", "gpt-4o-mini"],
        routing: {
          strategy: "prefer_order",
          prefer: ["gpt-4o", "gpt-4o-mini"],
          max_retries: 1,
        },
      },
      provider: async (ctx) => {
        calls += 1;
        if (ctx.model_routed === "gpt-4o") {
          const err = new Error("rate limited");
          err.status = 429;
          throw err;
        }
        ctx.provider_result = {
          model: ctx.model_routed,
          output: { content: "fallback-ok" },
          usage: { input_tokens: 10, output_tokens: 2 },
        };
        return ctx;
      },
    });
    const ctx = await gw.handleChatCompletions(
      {
        model: "gpt-4o",
        messages: [
          { role: "system", content: "y".repeat(200) },
          { role: "user", content: "go" },
        ],
        idempotency_key: "route-retry",
      },
      { key_id: "k1" }
    );
    assert.equal(ctx.aborted, false);
    assert.equal(calls, 2);
    assert.equal(ctx.model_routed, "gpt-4o-mini");
    assert.match(ctx.openai.choices[0].message.content, /fallback-ok/);
  });

  it("changing routed model is a policy edit (prefer_order)", async () => {
    const base = {
      ...CP_ON,
      seedBalance: 50,
      estimated_max_usd: 5,
      enableRouting: true,
    };
    const gwA = createWiredGateway({
      ...base,
      policy: {
        version: 1,
        allow_models: ["gpt-4o", "gpt-4o-mini"],
        routing: { strategy: "prefer_order", prefer: ["gpt-4o-mini", "gpt-4o"] },
      },
    });
    const gwB = createWiredGateway({
      ...base,
      policy: {
        version: 1,
        allow_models: ["gpt-4o", "gpt-4o-mini"],
        routing: { strategy: "prefer_order", prefer: ["gpt-4o", "gpt-4o-mini"] },
      },
    });
    const body = {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "z".repeat(100) },
        { role: "user", content: "q" },
      ],
    };
    const a = await gwA.handleChatCompletions({ ...body, idempotency_key: "pol-a" }, { key_id: "k" });
    const b = await gwB.handleChatCompletions({ ...body, idempotency_key: "pol-b" }, { key_id: "k" });
    assert.equal(a.model_routed, "gpt-4o-mini");
    assert.equal(b.model_routed, "gpt-4o");
  });
});

describe("wired gateway phase 6 live path (mocked providers)", () => {
  it("compress → route on retained → openai stream → finalize", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"usage":{"prompt_tokens":8,"completion_tokens":1}}\n\n' +
      "data: [DONE]\n\n";
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      async text() {
        return sse;
      },
      body: {
        getReader() {
          const enc = new TextEncoder();
          let done = false;
          return {
            async read() {
              if (done) return { done: true };
              done = true;
              return { done: false, value: enc.encode(sse) };
            },
          };
        },
      },
    });

    const gw = createWiredGateway({
      ...CP_ON,
      seedBalance: 50,
      estimated_max_usd: 2,
      enableRouting: true,
      openaiApiKey: "sk-test",
      allowStubFallback: false,
      requireLive: true,
      fetchImpl,
      neuralKeep: async () => null,
      policy: {
        version: 1,
        compress_default: true,
        max_usd_per_request: 2,
        allow_models: ["gpt-4o", "gpt-4o-mini"],
        routing: { strategy: "cheapest_fit", fallbacks: ["gpt-4o-mini"], max_retries: 1 },
      },
    });

    const ask = "summarize keep rules carefully";
    const ctx = await gw.handleChatCompletions(
      {
        model: "gpt-4o",
        stream: true,
        messages: [
          { role: "system", content: "x".repeat(800) },
          { role: "user", content: ask },
        ],
        idempotency_key: "phase6-stream",
      },
      { key_id: "k1", org_id: "o1" }
    );

    assert.equal(ctx.aborted, false);
    assert.equal(ctx.compression.strategy, "compiler");
    assert.ok(ctx.compression.retained_tokens > 0);
    assert.equal(ctx.model_routed, "gpt-4o-mini");
    assert.equal(ctx.provider_result.provider, "openai");
    assert.equal(ctx.provider_result.output.content, "hi");
    // Default path drains stream in finalize; content is on provider_result.
    assert.equal(ctx._stream_drained, true);
    const rec = gw.ledger.get(ctx.request_id);
    assert.equal(rec.status, "finalized");
    assert.equal(rec.provider, "openai");
    assert.ok(!JSON.stringify(ctx.compression).includes(ask));
  });

  it("flags still default off", () => {
    delete process.env.SC_CP_GATEWAY;
    delete process.env.SC_CP_ROUTE;
    delete process.env.SC_CP_TRACE;
    delete process.env.SC_CP_LEDGER;
    delete process.env.SC_CP_RESERVE;
    assert.equal(isGatewayEnabled(), false);
  });
});

describe("wired gateway flag gating", () => {
  const prev = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
  });

  it("SC_CP_TRACE=1 exposes sc_compression_trace on response", async () => {
    process.env.SC_CP_TRACE = "1";
    const gw = createWiredGateway({
      ...CP_ON,
      enableTrace: undefined,
      seedBalance: 20,
      estimated_max_usd: 1,
      neuralKeep: async () => null,
    });
    const ctx = await gw.handleChatCompletions(
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "ctx ".repeat(30) },
          { role: "user", content: "hi" },
        ],
        idempotency_key: "trace-on",
      },
      { key_id: "k1" }
    );
    assert.equal(ctx.aborted, false);
    assert.ok(ctx.openai.sc_compression_trace);
    assert.ok(ctx.openai.sc_economics);
    assert.ok(ctx.compression);
    assert.ok(ctx.economics);
  });

  it("compress-then-route economics unlocks cheaper model", async () => {
    const gw = createWiredGateway({
      ...CP_ON,
      enableTrace: true,
      enableRouting: true,
      seedBalance: 50,
      estimated_max_usd: 5,
      neuralKeep: async () => null,
      // Force retained size small enough for tiny; original would need huge
      compress: async (ctx) => {
        ctx.compression = {
          original_tokens: 50_000,
          retained_tokens: 4_000,
          ratio: 0.08,
          strategy: "compiler",
          unit: "tokens",
          model_eligibility: [],
        };
        ctx.compressed_messages = ctx.normalized?.messages || [];
        return ctx;
      },
      catalog: [
        {
          id: "tiny",
          provider: "stub",
          max_context_tokens: 8_000,
          input_usd_per_mtok: 0.1,
          output_usd_per_mtok: 0.1,
          capabilities: ["chat"],
          health: "up",
        },
        {
          id: "huge",
          provider: "stub",
          max_context_tokens: 200_000,
          input_usd_per_mtok: 5,
          output_usd_per_mtok: 5,
          capabilities: ["chat"],
          health: "up",
        },
      ],
      policy: {
        version: 1,
        compress_default: true,
        routing: { strategy: "cheapest_fit", output_tokens_reserve: 500 },
      },
    });
    const ctx = await gw.handleChatCompletions(
      {
        model: "huge",
        messages: [
          { role: "system", content: "x".repeat(100) },
          { role: "user", content: "CONTEXT:\nkeep\n\nREQUEST: hi" },
        ],
        idempotency_key: "econ-unlock",
      },
      { key_id: "k1", org_id: "o1" }
    );
    assert.equal(ctx.aborted, false);
    assert.equal(ctx.model_routed, "tiny");
    assert.equal(ctx.economics.model_changed, true);
    assert.equal(ctx.economics.without_compress.model, "huge");
    assert.equal(ctx.economics.with_compress.model, "tiny");
    assert.ok(ctx.economics.dollars_saved_est > 0);
    assert.ok(ctx.openai.sc_economics.dollars_saved_est > 0);
  });

  it("trace off omits sc_compression_trace from OpenAI-shaped response", async () => {
    delete process.env.SC_CP_TRACE;
    const gw = createWiredGateway({
      ...CP_ON,
      enableTrace: false,
      seedBalance: 20,
      estimated_max_usd: 1,
    });
    const ctx = await gw.handleChatCompletions(
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "ctx ".repeat(30) },
          { role: "user", content: "hi" },
        ],
        idempotency_key: "trace-off",
      },
      { key_id: "k1" }
    );
    assert.equal(ctx.aborted, false);
    assert.equal(ctx.openai.sc_compression_trace, undefined);
    assert.ok(ctx.compression);
  });

  it("SC_CP_LEDGER=0 skips durable ledger rows", async () => {
    delete process.env.SC_CP_LEDGER;
    const gw = createWiredGateway({
      enforceReserve: false,
      enableLedger: false,
      seedBalance: 20,
      estimated_max_usd: 1,
    });
    const ctx = await gw.handleChatCompletions(
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        idempotency_key: "ledger-off",
      },
      { key_id: "k1" }
    );
    assert.equal(ctx.aborted, false);
    assert.ok(ctx.request_id);
    assert.equal(gw.ledger.get(ctx.request_id), null);
    assert.equal(gw.ledger.list().length, 0);
  });

  it("fail closed when money store unhealthy and reserve required", async () => {
    const { createMemoryDurableStore } = require("../../packages/control-plane");
    const store = createMemoryDurableStore({ defaultBalance: 50, healthy: false });
    const gw = createWiredGateway({
      store,
      enforceReserve: true,
      enableLedger: true,
      estimated_max_usd: 1,
    });
    const ctx = await gw.handleChatCompletions(
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        idempotency_key: "money-down",
      },
      { key_id: "k1" }
    );
    assert.equal(ctx.aborted, true);
    assert.equal(ctx.error.message, "money_store_unavailable");
  });
});

describe("wired gateway phase 8 hardening", () => {
  it("enforces RPM via sliding window", async () => {
    const gw = createWiredGateway({
      ...CP_ON,
      seedBalance: 50,
      estimated_max_usd: 1,
      enableRouting: false,
      walletId: "wallet_rpm_test",
      neuralKeep: async () => null,
      policy: { version: 1, rpm: 1, compress_default: true },
    });
    const body = {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    };
    const auth = { key_id: "k-rpm-unique", org_id: "o-rpm" };
    const a = await gw.handleChatCompletions(
      { ...body, idempotency_key: "rpm-a" },
      auth
    );
    const b = await gw.handleChatCompletions(
      { ...body, idempotency_key: "rpm-b" },
      auth
    );
    assert.equal(a.aborted, false);
    assert.equal(b.aborted, true);
    assert.match(b.error.message, /rpm_exceeded/);
    assert.equal(b.error.status, 429);
  });

  it("replays finalized openai response for same idempotency key", async () => {
    const gw = createWiredGateway({
      ...CP_ON,
      seedBalance: 50,
      estimated_max_usd: 1,
      enableTrace: true,
      enableRouting: true,
      neuralKeep: async () => null,
    });
    const body = {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "ctx ".repeat(20) },
        { role: "user", content: "hello" },
      ],
      idempotency_key: "replay-1",
    };
    const first = await gw.handleChatCompletions(body, { key_id: "k1", org_id: "o1" });
    assert.equal(first.aborted, false);
    assert.ok(first.openai);
    const second = await gw.handleChatCompletions(body, { key_id: "k1", org_id: "o1" });
    assert.equal(second.idempotent_replay, true);
    assert.equal(second.openai.id, first.openai.id);
    assert.deepEqual(
      second.openai.choices[0].message,
      first.openai.choices[0].message
    );
  });

  it("circuit breaker marks model down and routes around it", async () => {
    const { createHealthTracker } = require("../../packages/control-plane");
    const ht = createHealthTracker({ failureThreshold: 2, cooldownMs: 60_000 });
    ht.recordFailure("gpt-4o-mini");
    ht.recordFailure("gpt-4o-mini");
    assert.equal(ht.healthMap()["gpt-4o-mini"], "down");

    const gw = createWiredGateway({
      ...CP_ON,
      seedBalance: 50,
      estimated_max_usd: 2,
      enableRouting: true,
      healthTracker: ht,
      neuralKeep: async () => null,
      policy: {
        version: 1,
        allow_models: ["gpt-4o-mini", "claude-haiku-3.5"],
        routing: { strategy: "cheapest_fit", output_tokens_reserve: 100 },
      },
    });
    const ctx = await gw.handleChatCompletions(
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "x".repeat(40) },
          { role: "user", content: "hi" },
        ],
        idempotency_key: "cb-1",
      },
      { key_id: "k1" }
    );
    assert.equal(ctx.aborted, false);
    assert.equal(ctx.model_routed, "claude-haiku-3.5");
  });
});
