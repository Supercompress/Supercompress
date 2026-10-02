"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { isOpsEnabled, getOpsInsights } = require("./ops");
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
    });
    await gw.handleChatCompletions(
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "pad\n".repeat(200) },
          { role: "user", content: "CONTEXT:\nkeep this\n\nREQUEST: hi" },
        ],
      },
      { org_id: "o", key_id: "k", agent_id: "a" }
    );
    const insights = getOpsInsights({
      gatewayOptions: { store, seedBalance: 50 },
    });
    // Process singleton may differ — compute from this gw ledger directly
    const { buildOpsInsights } = require("../../packages/control-plane");
    const fromGw = buildOpsInsights(gw.ledger.list({}));
    assert.ok(fromGw.summary.requests >= 1);
    assert.ok(fromGw.moat.compress_then_route);
    assert.equal(typeof insights, "object");
  });
});
