"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  isOpsEnabled,
  getOpsInsights,
  getOpsOtel,
  resolveOpsSurface,
} = require("./ops");
const { createWiredGateway } = require("./wire");
const { createMemoryDurableStore } = require("../../packages/control-plane");

describe("gateway ops surface", () => {
  const prev = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
  });

  it("ops flag defaults off", () => {
    delete process.env.SC_CP_OPS;
    assert.equal(isOpsEnabled(), false);
  });

  it("resolveOpsSurface prefers export=otel after rewrite collapse", () => {
    assert.equal(resolveOpsSurface("/api/v1/ops"), "insights");
    assert.equal(resolveOpsSurface("/api/v1/ops?export=otel"), "otel");
    assert.equal(resolveOpsSurface("/v1/ops/otel"), "otel");
    assert.equal(
      resolveOpsSurface("/api/v1/ops", { "x-matched-path": "/v1/ops/otel" }),
      "otel"
    );
  });

  it("insights reflect ledger economics after a traced request", async () => {
    process.env.SC_CP_OPS = "1";
    const store = createMemoryDurableStore({ defaultBalance: 50 });
    const gw = createWiredGateway({
      store,
      seedBalance: 50,
      allowStubFallback: true,
      enableRouting: true,
      enableTrace: true,
      enforceReserve: true,
      enableLedger: true,
      // Avoid live Neural Keep HTTP 503 / 30s stall in unit tests
      neuralKeep: async () => null,
    });
    const ctx = await gw.handleChatCompletions(
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "pad\n".repeat(200) },
          { role: "user", content: "CONTEXT:\nkeep this\n\nREQUEST: hi" },
        ],
      },
      { org_id: "o", key_id: "k", agent_id: "a" }
    );
    assert.equal(ctx.aborted, false);
    assert.ok(ctx.economics);

    const fromGw = getOpsInsights({ ledger: gw.ledger, org_id: "o" });
    assert.ok(fromGw.summary.requests >= 1);
    assert.ok(fromGw.moat.compress_then_route);
    assert.ok(fromGw.moat.requests_with_economics >= 1);
    assert.match(fromGw.moat.vs_litellm, /LiteLLM/);

    const otel = getOpsOtel({ ledger: gw.ledger, org_id: "o" });
    assert.equal(otel.confidential, true);
    assert.ok(otel.resourceSpans[0].scopeSpans[0].spans.length >= 1);
  });
});
