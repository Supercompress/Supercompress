"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { sumDaySpendUsd, startOfUtcDay } = require("./spend");
const { createWiredGateway } = require("../../services/gateway/wire");

describe("day spend", () => {
  it("sums actual + in-flight reserved for today only", () => {
    const start = startOfUtcDay(Date.UTC(2026, 9, 2, 15));
    const records = [
      {
        org_id: "o",
        key_id: "k",
        status: "finalized",
        actual_usd: 1.5,
        created_at: new Date(start + 1000).toISOString(),
      },
      {
        org_id: "o",
        key_id: "k",
        status: "reserved",
        reserved_usd: 0.5,
        created_at: new Date(start + 2000).toISOString(),
      },
      {
        org_id: "o",
        key_id: "k",
        status: "finalized",
        actual_usd: 9,
        created_at: new Date(start - 86_400_000).toISOString(),
      },
      {
        org_id: "other",
        key_id: "k",
        status: "finalized",
        actual_usd: 3,
        created_at: new Date(start + 3000).toISOString(),
      },
    ];
    assert.equal(
      sumDaySpendUsd(records, { org_id: "o", key_id: "k", nowMs: start + 5000 }),
      2
    );
  });

  it("gateway rejects when day budget exhausted", async () => {
    const gw = createWiredGateway({
      enableLedger: true,
      enforceReserve: true,
      seedBalance: 50,
      estimated_max_usd: 1,
      walletId: "wallet_day",
      neuralKeep: async () => null,
      policy: { version: 1, max_usd_per_day: 1, compress_default: true },
    });
    const auth = { key_id: "k-day", org_id: "o-day" };
    const body = {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    };
    const first = await gw.handleChatCompletions(
      { ...body, idempotency_key: "day-1" },
      auth
    );
    assert.equal(first.aborted, false);
    // Seed a large finalized spend for today
    const rec = gw.ledger.create({
      org_id: "o-day",
      key_id: "k-day",
      idempotency_key: "seed-spend",
    });
    gw.ledger.finalize(rec.id, { actual_usd: 5 });
    const second = await gw.handleChatCompletions(
      { ...body, idempotency_key: "day-2" },
      auth
    );
    assert.equal(second.aborted, true);
    assert.match(second.error.message, /max_usd_per_day/);
  });
});
