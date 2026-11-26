"use strict";

/**
 * Per-request observability: one obs record per request (ledger meta.obs), exported to the
 * ops insights and OTel, with no prompt/response content and no key material.
 */

// Wiring tests run on the deterministic legacy compiler; gateway compress tests cover the Fast engine.
process.env.SC_COMPRESS_ENGINE = "legacy";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createWiredGateway } = require("./wire");
const { writeOpenAiSse } = require("./http");
const { createOpenAIProvider } = require("./providers/openai");
const { createAnthropicProvider } = require("./providers/anthropic");
const { createCreditBilling } = require("../../api/_lib/cp-billing");
const { buildOpsInsights, buildOpsOtelExport } = require("../../packages/control-plane/insights");
const { fromAttributes } = require("../../packages/control-plane/otel");
const { errorCode, httpStatusFor, computeCost } = require("../../packages/control-plane/request-obs");
const { defaultCatalog } = require("../../packages/control-plane/catalog");

const TOOL_LOG = Array.from({ length: 120 }, (_, i) =>
  i % 9 === 0 ? `ERROR worker ${i} failed: timeout while reading shard ${i}` : `info step ${i} ok, 120ms, cache hit`
).join("\n");

function okProvider({ usage = { input_tokens: 1000, output_tokens: 100 }, provider = "openai", text = "answer" } = {}) {
  return async (ctx) => {
    ctx.provider_result = {
      model: ctx.model_routed,
      provider,
      output: { content: text },
      finish_reason: "stop",
      usage,
    };
    return ctx;
  };
}

function fakeBilling(balance, extraClaims = {}) {
  const state = { claims: { sc_credit_balance_usd: balance, ...extraClaims } };
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

function sseRes(events) {
  const text = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
  return { ok: true, status: 200, async text() { return text; } };
}

function fakeRes({ closeAfterWrites = Infinity } = {}) {
  const chunks = [];
  const headers = {};
  const res = {
    statusCode: 0,
    destroyed: false,
    writableEnded: false,
    setHeader: (k, v) => (headers[k.toLowerCase()] = v),
    write(s) {
      chunks.push(String(s));
      if (chunks.length >= closeAfterWrites) res.destroyed = true; // client hung up
    },
    end(s) {
      if (s) chunks.push(String(s));
      res.writableEnded = true;
    },
  };
  return { res, chunks, headers };
}

const AUTH = { org_id: "org_obs", key_id: "key_obs" };
const obsOf = (gw, ctx) => gw.ledger.get(ctx.request_id).meta.obs;

describe("request observability record", () => {
  it("passthrough: routing, compression, provider, cost and request id on one ledger row", async () => {
    const gw = createWiredGateway({
      enableLedger: true,
      provider: okProvider({ usage: { input_tokens: 900, output_tokens: 120, cached_input_tokens: 300 } }),
    });
    const ctx = await gw.handleChatCompletions(
      {
        model: "gpt-6.1-sol",
        messages: [
          { role: "user", content: "run the job" },
          { role: "tool", tool_call_id: "c1", content: TOOL_LOG },
          { role: "user", content: "summarize the failures" },
        ],
      },
      AUTH,
      { request_id: "req_edge_fixed_1" }
    );
    assert.equal(ctx.aborted, false);
    assert.equal(ctx.request_id, "req_edge_fixed_1", "the edge id is the ledger id");
    assert.equal(gw.ledger.list({}).length, 1, "exactly one record per request");
    const o = obsOf(gw, ctx);
    assert.equal(o.request_id, "req_edge_fixed_1");
    // What was requested, what was routed
    assert.equal(o.routing.requested_model, "gpt-6.1-sol");
    assert.equal(o.routing.model, "gpt-6.1-sol");
    assert.equal(o.routing.provider, "openai");
    assert.equal(o.routing.mode, "passthrough");
    assert.equal(o.routing.classifier, null);
    // Compression
    assert.equal(o.compression.mode, "compiler");
    assert.equal(o.compression.engine, "compiler");
    assert.ok(o.compression.original_tokens > o.compression.retained_tokens);
    assert.equal(o.compression.tokens_saved, o.compression.original_tokens - o.compression.retained_tokens);
    assert.equal(o.compression.passthrough_reason, null);
    assert.equal(typeof o.compression.latency_ms, "number");
    // Provider
    assert.equal(o.provider.status, "ok");
    assert.equal(o.provider.input_tokens, 900);
    assert.equal(o.provider.output_tokens, 120);
    assert.equal(o.provider.cached_input_tokens, 300);
    assert.equal(o.provider.usage_estimated, false);
    assert.equal(o.provider.attempts, 1);
    assert.equal(o.provider.retries, 0);
    assert.deepEqual(o.provider.fallbacks, []);
    assert.equal(o.provider.ttft_ms, null, "TTFT is a streaming metric");
    assert.equal(typeof o.provider.latency_ms, "number");
    assert.equal(o.provider.finish_reason, "stop");
    // Cost: sol is $2/$10 per MTok
    assert.equal(o.cost.list_usd, 0.003);
    assert.equal(o.cost.baseline_model, "gpt-6.1-sol");
    assert.equal(o.cost.baseline_basis, "requested");
    assert.equal(o.cost.saved_routing_usd, 0, "passthrough saves nothing by routing");
    assert.ok(o.cost.saved_compression_usd > 0);
    assert.equal(o.cost.saved_total_usd, o.cost.saved_compression_usd);
    assert.equal(o.cost.charged_usd, ctx.actual_usd);
    assert.equal(o.error, null);
    assert.equal(typeof o.latency_ms, "number");
  });

  it("auto: classifier decision, auto mode and routing savings against the top model", async () => {
    const gw = createWiredGateway({
      enableLedger: true,
      enableRouting: true,
      policy: { version: 1, compress_default: false },
      provider: okProvider(),
    });
    const ctx = await gw.handleChatCompletions(
      { model: "auto", messages: [{ role: "user", content: "Write the commit message" }] },
      AUTH
    );
    assert.equal(ctx.aborted, false);
    const o = obsOf(gw, ctx);
    assert.equal(o.routing.requested_model, "auto");
    assert.equal(o.routing.mode, "auto");
    assert.equal(o.routing.model, ctx.model_routed);
    assert.ok(o.routing.reason);
    assert.ok(o.routing.strategy);
    assert.equal(typeof o.routing.classifier.tier, "number");
    assert.ok(Array.isArray(o.routing.classifier.reasons) && o.routing.classifier.reasons.length);
    assert.ok("difficulty_score" in o.routing.classifier);
    assert.equal(o.compression.passthrough_reason, "compress_default_false");
    assert.equal(o.cost.baseline_basis, "top_model");
    assert.notEqual(o.cost.baseline_model, ctx.model_routed);
    assert.ok(o.cost.saved_routing_usd > 0, "an easy task served cheap saves money vs the top model");
    assert.equal(o.cost.saved_compression_usd, 0);
  });

  it("fallbacks: which provider failed, why, and how many retries", async () => {
    let first = true;
    const gw = createWiredGateway({
      enableLedger: true,
      enableRouting: true,
      policy: { version: 1, compress_default: false, routing: { strategy: "cheapest_fit" } },
      provider: async (ctx) => {
        if (first) {
          first = false;
          const err = new Error("overloaded");
          err.status = 503;
          throw err;
        }
        return okProvider()(ctx);
      },
    });
    const ctx = await gw.handleChatCompletions(
      { model: "auto", messages: [{ role: "user", content: "Write the commit message" }] },
      AUTH
    );
    assert.equal(ctx.aborted, false);
    const o = obsOf(gw, ctx);
    assert.equal(o.provider.attempts, 2);
    assert.equal(o.provider.retries, 1);
    assert.equal(o.provider.fallbacks.length, 1);
    const [f] = o.provider.fallbacks;
    assert.equal(f.http_status, 503);
    assert.equal(f.code, "provider_error");
    assert.ok(f.provider && f.model);
    assert.notEqual(f.model, o.routing.model);
  });
});

describe("stable error codes", () => {
  it("maps gateway errors to codes and HTTP statuses", () => {
    assert.equal(errorCode({ class: "rejected", code: "credits_required", status: 402 }), "credits_required");
    assert.equal(errorCode({ class: "rejected", code: "daily_cap_reached", status: 402 }), "daily_cap_reached");
    assert.equal(errorCode({ class: "rejected", message: "rpm_exceeded", status: 429 }), "rate_limited");
    assert.equal(errorCode({ class: "invalid_request", message: "model_not_found: x", code: "model_not_found" }), "model_not_found");
    assert.equal(errorCode({ class: "error", message: "Internal upstream text", status: 500 }), "provider_error");
    assert.equal(errorCode({ class: "error", message: "client_closed_request", code: "client_closed_request", status: 499 }), "client_closed_request");
    assert.equal(errorCode({ class: "rejected", message: "max_usd_per_request:5>1" }), "max_usd_per_request");
    // Free text never becomes a code.
    assert.equal(errorCode({ class: "error", code: "Some Sentence with spaces", status: 502 }), "provider_error");
    assert.equal(httpStatusFor({ class: "rejected", message: "rpm_exceeded" }), 429);
    assert.equal(httpStatusFor({ class: "rejected", code: "credits_required", status: 402 }), 402);
  });

  it("402 credits_required and daily_cap_reached are recorded with their codes", async () => {
    const broke = fakeBilling(0);
    const gw = createWiredGateway({ enableLedger: true, billing: broke.billing, provider: okProvider() });
    const a = await gw.handleChatCompletions({ model: "gpt-6-luna", messages: [{ role: "user", content: "hi" }] }, AUTH);
    assert.equal(a.aborted, true);
    assert.deepEqual(obsOf(gw, a).error, { code: "credits_required", http_status: 402, class: "rejected" });
    assert.equal(obsOf(gw, a).provider, null, "no provider call on a rejected request");

    const capped = fakeBilling(10, { sc_cp_daily_cap_usd: 0 });
    const gw2 = createWiredGateway({ enableLedger: true, billing: capped.billing, provider: okProvider() });
    const b = await gw2.handleChatCompletions({ model: "gpt-6-luna", messages: [{ role: "user", content: "hi" }] }, AUTH);
    assert.equal(obsOf(gw2, b).error.code, "daily_cap_reached");
    assert.equal(obsOf(gw2, b).error.http_status, 402);
  });

  it("429 rate_limited, 400 model_not_found and provider 5xx are recorded with their codes", async () => {
    const gw = createWiredGateway({
      enableLedger: true,
      policy: { version: 1, rpm: 1 },
      provider: okProvider(),
    });
    const req = { model: "gpt-6-luna", messages: [{ role: "user", content: "hi" }] };
    await gw.handleChatCompletions(req, AUTH);
    const limited = await gw.handleChatCompletions(req, AUTH);
    assert.equal(obsOf(gw, limited).error.code, "rate_limited");
    assert.equal(obsOf(gw, limited).error.http_status, 429);

    const gw2 = createWiredGateway({ enableLedger: true, provider: okProvider() });
    const nf = await gw2.handleChatCompletions({ ...req, model: "no-such-model" }, AUTH);
    assert.deepEqual(obsOf(gw2, nf).error, { code: "model_not_found", http_status: 400, class: "invalid_request" });
    assert.equal(obsOf(gw2, nf).routing.requested_model, "no-such-model");

    const gw3 = createWiredGateway({
      enableLedger: true,
      provider: async () => {
        const err = new Error("upstream exploded with secret details");
        err.status = 500;
        throw err;
      },
    });
    const boom = await gw3.handleChatCompletions(req, AUTH);
    const o = obsOf(gw3, boom);
    assert.deepEqual(o.error, { code: "provider_error", http_status: 500, class: "error" });
    assert.equal(o.provider.status, "error");
    assert.equal(o.provider.fallbacks[0].http_status, 500);
    assert.equal(o.cost.charged_usd, 0);
  });
});

describe("streaming observability", () => {
  it("records TTFT and the usage the provider reports at the end of the stream", async () => {
    const fetchImpl = async () =>
      sseRes([
        { choices: [{ index: 0, delta: { content: "Hel" } }] },
        { choices: [{ index: 0, delta: { content: "lo" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 10 } } },
        "[DONE]",
      ]);
    const gw = createWiredGateway({
      enableLedger: true,
      deferStreamFinalize: true,
      provider: createOpenAIProvider({ apiKey: "sk-test", fetchImpl }),
    });
    const ctx = await gw.handleChatCompletions(
      { model: "gpt-6-luna", stream: true, messages: [{ role: "user", content: "hi" }] },
      AUTH
    );
    const { res, headers } = fakeRes();
    await writeOpenAiSse(res, ctx);
    await gw.finalizeDeferred(ctx);
    assert.equal(headers["x-sc-request-id"], ctx.request_id);
    const o = obsOf(gw, ctx);
    assert.equal(o.stream, true);
    assert.equal(o.error, null);
    assert.equal(typeof o.provider.ttft_ms, "number");
    assert.ok(o.provider.ttft_ms <= o.latency_ms);
    assert.equal(o.provider.input_tokens, 50);
    assert.equal(o.provider.output_tokens, 2);
    assert.equal(o.provider.cached_input_tokens, 10);
    assert.equal(o.provider.usage_estimated, false);
    assert.equal(o.provider.finish_reason, "stop");
  });

  it("a client disconnect mid-stream still records a row, with usage seen so far", async () => {
    const paid = fakeBilling(5);
    const pieces = Array.from({ length: 50 }, (_, i) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `chunk${i} ` } }));
    const fetchImpl = async () =>
      sseRes([
        { type: "message_start", message: { usage: { input_tokens: 120, cache_read_input_tokens: 30, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        ...pieces,
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 400 } },
        { type: "message_stop" },
      ]);
    const gw = createWiredGateway({
      enableLedger: true,
      billing: paid.billing,
      deferStreamFinalize: true,
      provider: createAnthropicProvider({ apiKey: "sk-ant-test", fetchImpl }),
    });
    const ctx = await gw.handleChatCompletions(
      { model: "claude-sonnet-5-5", stream: true, messages: [{ role: "user", content: "hi" }] },
      AUTH
    );
    const { res, chunks } = fakeRes({ closeAfterWrites: 3 });
    await writeOpenAiSse(res, ctx);
    await gw.finalizeDeferred(ctx);
    assert.ok(chunks.length < 10, "stopped writing once the client was gone");
    const rows = gw.ledger.list({});
    assert.equal(rows.length, 1);
    const rec = rows[0];
    assert.equal(rec.status, "finalized");
    const o = rec.meta.obs;
    assert.deepEqual(o.error, { code: "client_closed_request", http_status: 499, class: "cancelled" });
    assert.equal(o.provider.status, "cancelled");
    assert.equal(o.provider.input_tokens, 150, "input usage from message_start survives the disconnect");
    assert.equal(o.provider.cached_input_tokens, 30);
    assert.ok(o.provider.output_tokens >= 1);
    assert.equal(typeof o.provider.ttft_ms, "number");
    assert.ok(o.cost.list_usd > 0, "what the partial call cost at list price is recorded");
    assert.equal(o.cost.charged_usd, 0);
    assert.equal(paid.state.claims.sc_credit_balance_usd, 5, "hold released");
  });

  it("a disconnect before usage arrives estimates usage and flags it", async () => {
    const gw = createWiredGateway({
      enableLedger: true,
      deferStreamFinalize: true,
      provider: async (ctx) => {
        ctx.provider_result = {
          model: ctx.model_routed,
          provider: "openai",
          output: { content: "" },
          usage: { input_tokens: 0, output_tokens: 0 },
          stream: (async function* () {
            for (let i = 0; i < 100; i++) yield { content: "abcdefgh" };
          })(),
        };
        return ctx;
      },
    });
    const ctx = await gw.handleChatCompletions(
      { model: "gpt-6-luna", stream: true, messages: [{ role: "user", content: "hello there" }] },
      AUTH
    );
    const { res } = fakeRes({ closeAfterWrites: 4 });
    await writeOpenAiSse(res, ctx);
    await gw.finalizeDeferred(ctx);
    const o = obsOf(gw, ctx);
    assert.equal(o.error.code, "client_closed_request");
    assert.equal(o.provider.usage_estimated, true);
    assert.ok(o.provider.output_tokens > 0);
    assert.ok(o.provider.input_tokens > 0);
  });
});

describe("ops insights and OTel carry the obs fields", () => {
  async function seeded() {
    const gw = createWiredGateway({
      enableLedger: true,
      enableRouting: true,
      provider: okProvider(),
    });
    await gw.handleChatCompletions({ model: "auto", messages: [{ role: "user", content: "Write the commit message" }] }, AUTH);
    await gw.handleChatCompletions(
      {
        model: "gpt-6.1-sol",
        messages: [
          { role: "tool", tool_call_id: "c1", content: TOOL_LOG },
          { role: "user", content: "summarize" },
        ],
      },
      AUTH
    );
    await gw.handleChatCompletions({ model: "nope", messages: [{ role: "user", content: "hi" }] }, AUTH);
    return gw;
  }

  it("insights aggregate requests, error rate, p50/p95, spend and savings by routing vs compression", async () => {
    const gw = await seeded();
    const ins = buildOpsInsights(gw.ledger.list({}), { org_id: AUTH.org_id });
    const g = ins.gateway;
    assert.equal(g.requests, 3);
    assert.equal(g.errors, 1);
    assert.equal(g.error_rate, 0.3333);
    assert.deepEqual(g.errors_by_code, { model_not_found: 1 });
    assert.equal(g.auto_routed, 1);
    assert.equal(typeof g.latency_ms.p50, "number");
    assert.equal(typeof g.latency_ms.p95, "number");
    assert.ok(g.spend_usd > 0);
    assert.ok(g.savings.routing_usd > 0);
    assert.ok(g.savings.compression_usd > 0);
    assert.equal(g.savings.total_usd, Math.round((g.savings.routing_usd + g.savings.compression_usd) * 1e6) / 1e6);
    assert.equal(g.recent.length, 3);
    const auto = g.recent.find((r) => r.mode === "auto");
    assert.equal(auto.requested_model, "auto");
    assert.ok(auto.model && auto.provider && auto.route_reason);
    assert.equal(typeof auto.tier, "number");
    assert.ok(auto.saved_routing_usd > 0);
    const err = g.recent.find((r) => r.error_code);
    assert.equal(err.error_code, "model_not_found");
    assert.equal(err.http_status, 400);
    assert.equal(ins.summary.error_rate, 0.3333);
  });

  it("OTel spans carry routing, compression, provider, cost and error-code attributes", async () => {
    const gw = await seeded();
    const rows = gw.ledger.list({});
    const bundle = buildOpsOtelExport(rows, {});
    const spans = bundle.resourceSpans[0].scopeSpans[0].spans;
    assert.equal(spans.length, 3);
    const byId = Object.fromEntries(spans.map((s) => [fromAttributes(s.attributes)["sc.request_id"], s]));
    for (const r of rows) {
      const span = byId[r.id];
      assert.ok(span);
      // Stable trace id per request: a re-export lands on the same trace.
      assert.equal(span.traceId, buildOpsOtelExport([r]).resourceSpans[0].scopeSpans[0].spans[0].traceId);
      const a = fromAttributes(span.attributes);
      if (r.meta.obs.error) {
        assert.equal(a["sc.error.code"], "model_not_found");
        assert.equal(a["http.response.status_code"], 400);
        assert.equal(span.status.message, "model_not_found");
        continue;
      }
      assert.ok(["auto", "passthrough"].includes(a["sc.route.mode"]));
      assert.equal(a["gen_ai.usage.input_tokens"], 1000);
      assert.equal(a["gen_ai.usage.output_tokens"], 100);
      assert.equal(typeof a["sc.provider.latency_ms"], "number");
      assert.equal(typeof a["sc.cost.list_usd"], "number");
      assert.equal(typeof a["sc.savings.routing_usd"], "number");
      assert.equal(typeof a["sc.savings.compression_usd"], "number");
      assert.equal(a["http.response.status_code"], 200);
      if (a["sc.route.mode"] === "auto") assert.equal(typeof a["sc.route.classifier.tier"], "number");
      else assert.equal(a["sc.compress.mode"], "compiler");
    }
  });

  it("OTel exports fallbacks as span events", async () => {
    let first = true;
    const gw = createWiredGateway({
      enableLedger: true,
      enableRouting: true,
      policy: { version: 1, routing: { strategy: "cheapest_fit" } },
      provider: async (ctx) => {
        if (first) {
          first = false;
          throw Object.assign(new Error("overloaded"), { status: 529 });
        }
        return okProvider()(ctx);
      },
    });
    await gw.handleChatCompletions({ model: "auto", messages: [{ role: "user", content: "Write the commit message" }] }, AUTH);
    const span = buildOpsOtelExport(gw.ledger.list({})).resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(span.events.length, 1);
    const ev = fromAttributes(span.events[0].attributes);
    assert.equal(ev["http.response.status_code"], 529);
    assert.equal(ev["sc.error.code"], "provider_error");
    assert.equal(fromAttributes(span.attributes)["sc.provider.retries"], 1);
  });

  it("computeCost splits savings so routing + compression = baseline - list", () => {
    const cat = defaultCatalog();
    const c = computeCost({ catalog: cat, requested: "auto", routed: "gpt-6-luna", inputTokens: 1000, outputTokens: 100, tokensSaved: 4000, chargedUsd: 0.0002 });
    assert.equal(c.baseline_basis, "top_model");
    assert.equal(Math.round((c.saved_routing_usd + c.saved_compression_usd) * 1e6) / 1e6, Math.round((c.baseline_usd - c.list_usd) * 1e6) / 1e6);
    assert.equal(c.saved_compression_usd, 0.0004); // 4000 tok * $0.1/MTok
  });
});

describe("no content or secrets in records, exports or logs", () => {
  const PROMPT = "PROMPT_CANARY_7f3a the secret plan";
  const ANSWER = "RESPONSE_CANARY_9b2c the secret answer";
  const API_KEY = "sk-live-PROVIDERKEY-0123456789abcdef";

  function capture() {
    const lines = [];
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map(String).join(" "));
    return { lines, restore: () => Object.assign(console, orig) };
  }

  it("ledger rows, insights, OTel and logs never contain prompts, completions or keys", async () => {
    const fetchImpl = async (_url, init) => {
      assert.match(init.headers.Authorization, /PROVIDERKEY/); // the key reaches the provider only
      const body = JSON.parse(init.body);
      if (body.stream) {
        return sseRes([
          { choices: [{ index: 0, delta: { content: ANSWER } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 8 } },
          "[DONE]",
        ]);
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { model: body.model, choices: [{ message: { content: ANSWER }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 8 } };
        },
      };
    };
    let fail = false;
    const real = createOpenAIProvider({ apiKey: API_KEY, fetchImpl });
    const gw = createWiredGateway({
      enableLedger: true,
      enableTrace: true,
      enableRouting: true,
      deferStreamFinalize: true,
      provider: async (ctx, call) => {
        if (fail) throw Object.assign(new Error(`upstream said: ${PROMPT}`), { status: 500 });
        return real(ctx, call);
      },
    });
    const cap = capture();
    try {
      const msgs = [
        { role: "system", content: `${PROMPT} system` },
        { role: "tool", tool_call_id: "c", content: `${PROMPT}\n${TOOL_LOG}` },
        { role: "user", content: PROMPT },
      ];
      await gw.handleChatCompletions({ model: "gpt-6-luna", messages: msgs }, AUTH);
      await gw.handleChatCompletions({ model: "auto", messages: msgs }, AUTH);
      const s = await gw.handleChatCompletions({ model: "gpt-6-luna", stream: true, messages: msgs }, AUTH);
      await writeOpenAiSse(fakeRes().res, s);
      await gw.finalizeDeferred(s);
      fail = true;
      await gw.handleChatCompletions({ model: "gpt-6-luna", messages: msgs }, AUTH);
    } finally {
      cap.restore();
    }
    const rows = gw.ledger.list({});
    assert.equal(rows.length, 4);
    // Upstream error text may echo content: it is not part of obs or the OTel status.
    const obsBlob = JSON.stringify(rows.map((r) => r.meta.obs));
    const otel = buildOpsOtelExport(rows);
    const otelBlob = JSON.stringify(otel);
    const insightsBlob = JSON.stringify(buildOpsInsights(rows));
    const logBlob = cap.lines.join("\n");
    for (const [name, blob] of [["obs", obsBlob], ["otel", otelBlob], ["insights", insightsBlob], ["logs", logBlob]]) {
      assert.equal(blob.includes("PROMPT_CANARY"), false, `${name} leaks the prompt`);
      assert.equal(blob.includes("RESPONSE_CANARY"), false, `${name} leaks the completion`);
      assert.equal(blob.includes("PROVIDERKEY"), false, `${name} leaks the provider key`);
    }
    const ledgerBlob = JSON.stringify(rows);
    assert.equal(ledgerBlob.includes("PROMPT_CANARY"), false);
    assert.equal(ledgerBlob.includes("RESPONSE_CANARY"), false);
    assert.equal(ledgerBlob.includes("PROVIDERKEY"), false);
  });
});

describe("observability on the Fast engine", () => {
  it("records engine fast, savings and no passthrough reason", async () => {
    const previous = process.env.SC_COMPRESS_ENGINE;
    delete process.env.SC_COMPRESS_ENGINE;
    try {
      const gw = createWiredGateway({ enableLedger: true, provider: okProvider() });
      const log = Array.from({ length: 400 }, (_, i) =>
        i % 9 === 0 ? `ERROR worker ${i} failed: timeout while reading shard ${i}` : `info step ${i} ok, 120ms, cache hit`
      ).join("\n");
      const ctx = await gw.handleChatCompletions(
        {
          model: "gpt-6.1-sol",
          messages: [
            { role: "user", content: "run the job" },
            { role: "tool", tool_call_id: "c1", content: log },
            { role: "user", content: "Which workers failed and on which shard?" },
          ],
        },
        AUTH
      );
      const o = obsOf(gw, ctx);
      assert.equal(o.compression.engine, "fast");
      assert.ok(o.compression.retained_tokens < o.compression.original_tokens);
      assert.equal(o.compression.passthrough_reason, null);
      assert.ok(!JSON.stringify(o).includes("Which workers failed"), "the ask is never recorded");
    } finally {
      if (previous === undefined) delete process.env.SC_COMPRESS_ENGINE;
      else process.env.SC_COMPRESS_ENGINE = previous;
    }
  });
});
