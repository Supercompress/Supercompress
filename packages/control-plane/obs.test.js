"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { summarizeRequests, evaluateAlerts, summarizeEvalComparison } = require("./obs");

describe("obs", () => {
  it("summarizes spend, compress, top agents", () => {
    const s = summarizeRequests([
      {
        status: "finalized",
        actual_usd: 0.2,
        agent_id: "a1",
        latency_ms: 10,
        compression: {
          original_tokens: 100,
          retained_tokens: 40,
          dollars_avoided_est: 0.01,
        },
      },
      {
        status: "finalized",
        actual_usd: 0.5,
        agent_id: "a2",
        error_class: "error",
        latency_ms: 30,
        compression: {
          original_tokens: 100,
          retained_tokens: 40,
          dollars_avoided_est: 0.01,
        },
      },
    ]);
    assert.equal(s.requests, 2);
    assert.equal(s.spend_usd, 0.7);
    assert.equal(s.compression.ratio, 0.4);
    assert.equal(s.top_agents[0].agent_id, "a2");
    assert.equal(s.latency_ms.p50, 10);
  });

  it("budget alerts", () => {
    const alerts = evaluateAlerts(
      { spend_usd: 85, requests: 10, errors: 0, compression: { ratio: 0.4 } },
      { budget_usd: 100 }
    );
    assert.ok(alerts.some((a) => a.code === "budget_80"));
  });

  it("summarizeEvalComparison", () => {
    const s = summarizeEvalComparison({
      task_count: 4,
      aggregates: {
        direct: { spend_per_successful_task: 0.02, success_rate: 1, quality_avg: 1, dollars_avoided_est: 0 },
        gateway: {
          spend_per_successful_task: 0.01,
          success_rate: 0.75,
          quality_avg: 0.8,
          dollars_avoided_est: 0.005,
        },
      },
      comparison: {
        gateway_vs_direct: { cheaper_per_success: true },
        notes: ["gateway_cheaper_per_successful_task"],
      },
    });
    assert.equal(s.paths.length, 2);
    assert.equal(s.spend_per_successful_task.gateway, 0.01);
    assert.equal(s.gateway_vs_direct.cheaper_per_success, true);
  });
});
