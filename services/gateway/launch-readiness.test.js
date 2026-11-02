"use strict";

/**
 * Regression tests for the Control Plane launch blockers (tenant safety, billing, wire
 * compatibility). Each test names the audit finding it pins.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createWiredGateway } = require("./wire");
const { createProvider } = require("./providers");
const { createAnthropicProvider, buildAnthropicBody } = require("./providers/anthropic");
const { createOpenAIProvider } = require("./providers/openai");
const { writeOpenAiSse } = require("./http");
const { createCreditBilling } = require("../../api/_lib/cp-billing");

function okProvider(text = "answer") {
  return async (ctx) => {
    ctx.provider_result = {
      model: ctx.model_routed,
      provider: "openai",
      output: { content: text },
      finish_reason: "stop",
      usage: { input_tokens: 1000, output_tokens: 100 },
    };
    return ctx;
  };
}

function jsonRes(status, body) {
  return {
    ok: status < 400,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function sseRes(events) {
  const text = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
  return {
    ok: true,
    status: 200,
    async text() {
      return text;
    },
  };
}

function fakeBilling(balance) {
  const state = { claims: { sc_credit_balance_usd: balance } };
  const billing = createCreditBilling({
    env: {},
    claimsLedger: () => true,
    getClaims: async () => ({ ...state.claims }),
    patchClaims: async (_uid, mutator) => {
      state.claims = mutator({ ...state.claims });
      return state.claims;
    },
  });
  return { billing, state };
}

const body = (extra = {}) => ({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

describe("launch blockers", () => {
  it("SEC-3/SEC-8: no stub answers by default; missing provider key is an error", async () => {
    const gw = createWiredGateway({ enableLedger: true, fetchImpl: async () => jsonRes(500, {}) });
    const ctx = await gw.handleChatCompletions(body(), { org_id: "o1", key_id: "k1" });
    assert.equal(ctx.aborted, true);
    assert.notEqual(ctx.openai?.choices?.[0]?.message?.content, "ok");
    // With no key: openai_api_key_missing. With a key in the env: the mocked 500. Never the stub.
    assert.match(String(ctx.error.message), /api_key_missing|openai_http_500|upstream/);
  });

  it("MONEY-9: unknown models are rejected, not billed at a guess", async () => {
    const gw = createWiredGateway({ provider: okProvider() });
    const ctx = await gw.handleChatCompletions(body({ model: "made-up-model" }), { org_id: "o1", key_id: "k1" });
    assert.equal(ctx.aborted, true);
    assert.equal(ctx.error.status, 400);
    assert.equal(ctx.error.code, "model_not_found");
  });

  it("SEC-2: idempotency keys never replay another tenant's completion", async () => {
    let n = 0;
    const gw = createWiredGateway({
      enableLedger: true,
      provider: async (ctx) => okProvider(`answer-${++n}`)(ctx),
    });
    const a = await gw.handleChatCompletions(body({ idempotency_key: "same" }), { org_id: "A", key_id: "ka" });
    const b = await gw.handleChatCompletions(body({ idempotency_key: "same" }), { org_id: "B", key_id: "kb" });
    assert.equal(a.openai.choices[0].message.content, "answer-1");
    assert.equal(b.openai.choices[0].message.content, "answer-2");
    const again = await gw.handleChatCompletions(body({ idempotency_key: "same" }), { org_id: "A", key_id: "ka" });
    assert.equal(again.idempotent_replay, true);
    assert.equal(again.openai.choices[0].message.content, "answer-1");
    assert.equal(n, 2);
  });

  it("SEC-4/MONEY-1: free accounts get 402; paid accounts are charged the actual cost", async () => {
    const free = fakeBilling(0);
    const gwFree = createWiredGateway({ provider: okProvider(), billing: free.billing });
    const denied = await gwFree.handleChatCompletions(body(), { org_id: "free", key_id: "k" });
    assert.equal(denied.aborted, true);
    assert.equal(denied.error.status, 402);
    assert.equal(denied.error.code, "credits_required");

    const paid = fakeBilling(10);
    const gw = createWiredGateway({ provider: okProvider(), billing: paid.billing });
    const ctx = await gw.handleChatCompletions(body(), { org_id: "paid", key_id: "k" });
    assert.equal(ctx.aborted, false);
    // gpt-4o-mini: 1000 in × $0.15/M + 100 out × $0.60/M
    assert.equal(ctx.actual_usd, 0.00021);
    assert.equal(paid.state.claims.sc_credit_balance_usd, 9.99979);
    assert.equal(paid.billing.outstanding("paid"), 0);
  });

  it("MONEY-1: provider failure releases the hold and charges nothing", async () => {
    const paid = fakeBilling(1);
    const gw = createWiredGateway({
      billing: paid.billing,
      provider: async () => {
        const err = new Error("boom");
        err.status = 500;
        throw err;
      },
    });
    const ctx = await gw.handleChatCompletions(body(), { org_id: "o", key_id: "k" });
    assert.equal(ctx.aborted, true);
    assert.equal(paid.state.claims.sc_credit_balance_usd, 1);
    assert.equal(paid.billing.outstanding("o"), 0);
  });

  it("GW-8: a tenant's 4xx does not trip the shared circuit breaker", async () => {
    const gw = createWiredGateway({
      healthFailureThreshold: 2,
      provider: async () => {
        const err = new Error("bad request");
        err.status = 400;
        throw err;
      },
    });
    for (let i = 0; i < 4; i++) await gw.handleChatCompletions(body(), { org_id: "o", key_id: "k" });
    assert.notEqual(gw.healthTracker.healthMap()["gpt-4o-mini"], "down");
  });

  it("GW-3: a stream that dies mid-way is finalized as an error, not a success", async () => {
    const paid = fakeBilling(5);
    const gw = createWiredGateway({
      enableLedger: true,
      billing: paid.billing,
      deferStreamFinalize: true,
      provider: async (ctx) => {
        ctx.provider_result = {
          model: ctx.model_routed,
          provider: "openai",
          output: { content: "" },
          usage: { input_tokens: 0, output_tokens: 0 },
          stream: (async function* () {
            yield { content: "par" };
            const err = new Error("upstream_stream_error");
            err.status = 502;
            throw err;
          })(),
        };
        return ctx;
      },
    });
    const ctx = await gw.handleChatCompletions(body({ stream: true }), { org_id: "o", key_id: "k" });
    const chunks = [];
    const res = {
      statusCode: 0,
      setHeader() {},
      write: (s) => chunks.push(String(s)),
      end: (s) => s && chunks.push(String(s)),
    };
    await writeOpenAiSse(res, ctx);
    await gw.finalizeDeferred(ctx);
    const out = chunks.join("");
    assert.match(out, /"role":"assistant"/);
    assert.match(out, /upstream_stream_error/);
    assert.doesNotMatch(out, /"finish_reason":"stop"/);
    assert.equal(ctx.aborted, true);
    assert.equal(gw.ledger.get(ctx.request_id).error_class, "error");
    assert.equal(paid.state.claims.sc_credit_balance_usd, 5);
  });

  it("E2E-3/GP-6: OpenAI params pass through; reasoning models get max_completion_tokens", async () => {
    let sent;
    const provider = createProvider({
      openaiApiKey: "sk",
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(init.body);
        return jsonRes(200, { model: "o3", choices: [{ message: { content: "x" }, finish_reason: "length" }] });
      },
    });
    const gw = createWiredGateway({ provider, catalog: [{ id: "o3", provider: "openai", max_context_tokens: 200000, input_usd_per_mtok: 2, output_usd_per_mtok: 8 }] });
    const ctx = await gw.handleChatCompletions(
      body({ model: "o3", top_p: 0.5, stop: ["\n"], seed: 7, response_format: { type: "json_object" }, max_completion_tokens: 50 }),
      { org_id: "o", key_id: "k" }
    );
    assert.equal(ctx.aborted, false);
    assert.equal(sent.top_p, 0.5);
    assert.deepEqual(sent.stop, ["\n"]);
    assert.equal(sent.seed, 7);
    assert.deepEqual(sent.response_format, { type: "json_object" });
    assert.equal(sent.max_completion_tokens, 50);
    assert.equal(sent.max_tokens, undefined);
    assert.equal(ctx.openai.choices[0].finish_reason, "length");
  });

  it("E2E-4: OpenAI tool calls round-trip (request messages and response tool_calls)", async () => {
    let sent;
    const toolCall = { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } };
    const provider = createProvider({
      openaiApiKey: "sk",
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(init.body);
        return jsonRes(200, {
          choices: [{ message: { role: "assistant", content: null, tool_calls: [toolCall] }, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      },
    });
    const gw = createWiredGateway({ provider });
    const ctx = await gw.handleChatCompletions(
      body({
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
        messages: [
          { role: "user", content: "weather?" },
          { role: "assistant", content: null, tool_calls: [toolCall] },
          { role: "tool", tool_call_id: "call_1", content: "sunny" },
          { role: "user", content: "and tomorrow?" },
        ],
      }),
      { org_id: "o", key_id: "k" }
    );
    assert.equal(sent.messages[1].tool_calls[0].id, "call_1");
    assert.equal(sent.messages[2].tool_call_id, "call_1");
    const msg = ctx.openai.choices[0].message;
    assert.equal(msg.content, null);
    assert.deepEqual(msg.tool_calls, [toolCall]);
    assert.equal(ctx.openai.choices[0].finish_reason, "tool_calls");
  });

  it("E2E-4/GP-1/GP-3: Anthropic tool use, developer role, stop_reason and cache usage map to OpenAI", async () => {
    const b = buildAnthropicBody({
      model_routed: "claude-haiku-5-5",
      normalized: {
        temperature: 1.6,
        messages: [
          { role: "developer", content: "be brief" },
          { role: "user", content: "weather?" },
          { role: "assistant", content: null, tool_calls: [{ id: "tu_1", type: "function", function: { name: "w", arguments: '{"c":1}' } }] },
          { role: "tool", tool_call_id: "tu_1", content: "sunny" },
        ],
      },
    });
    assert.equal(b.system, "be brief");
    assert.equal(b.temperature, 1);
    assert.equal(b.messages[1].content[0].type, "tool_use");
    assert.deepEqual(b.messages[1].content[0].input, { c: 1 });
    assert.equal(b.messages[2].content[0].type, "tool_result");

    const call = createAnthropicProvider({
      apiKey: "ak",
      fetchImpl: async () =>
        jsonRes(200, {
          model: "claude-haiku-5-5",
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "tu_2", name: "w", input: { c: 2 } }],
          usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 4 },
        }),
    });
    const ctx = await call({ model_routed: "claude-haiku-5-5", normalized: { messages: [{ role: "user", content: "x" }] } });
    assert.equal(ctx.provider_result.finish_reason, "tool_calls");
    assert.equal(ctx.provider_result.output.tool_calls[0].function.arguments, '{"c":2}');
    assert.equal(ctx.provider_result.usage.input_tokens, 100);
    assert.equal(ctx.provider_result.usage.cached_input_tokens, 90);
  });

  it("E2E-4: streamed OpenAI tool-call deltas reach the client", async () => {
    const call = createOpenAIProvider({
      apiKey: "sk",
      fetchImpl: async () =>
        sseRes([
          { choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "f", arguments: "" } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          "[DONE]",
        ]),
    });
    const ctx = { model_routed: "gpt-4o-mini", normalized: { stream: true, messages: [{ role: "user", content: "x" }] } };
    await call(ctx);
    const pieces = [];
    for await (const p of ctx.provider_result.stream) pieces.push(p);
    assert.ok(pieces.every((p) => p.tool_calls));
    assert.equal(ctx.provider_result.finish_reason, "tool_calls");
    assert.equal(ctx.provider_result.output.tool_calls[0].function.arguments, '{"a":1}');
  });

  it("GW-5: our provider account's 401/quota errors become 502s that do not leak details", async () => {
    const call = createOpenAIProvider({
      apiKey: "sk",
      fetchImpl: async () => jsonRes(429, { error: { code: "insufficient_quota", message: "You exceeded your current quota, org-123" } }),
    });
    await assert.rejects(
      call({ model_routed: "gpt-4o-mini", normalized: { messages: [] } }),
      (e) => e.status === 502 && e.code === "upstream_provider_unavailable" && !/org-123/.test(e.message)
    );
  });

  it("GW-10: a hung provider times out instead of holding the request forever", async () => {
    const call = createOpenAIProvider({
      apiKey: "sk",
      timeoutMs: 50,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    await assert.rejects(
      call({ model_routed: "gpt-4o-mini", normalized: { messages: [] } }),
      (e) => e.status === 504 && e.code === "upstream_timeout"
    );
  });

  it("DOC-9: project_id is written to the ledger", async () => {
    const gw = createWiredGateway({ enableLedger: true, provider: okProvider() });
    const ctx = await gw.handleChatCompletions(body({ metadata: { project_id: "proj-7" } }), { org_id: "o", key_id: "k" });
    assert.equal(gw.ledger.get(ctx.request_id).project_id, "proj-7");
  });
});
