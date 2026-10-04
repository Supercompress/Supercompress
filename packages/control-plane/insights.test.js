"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { recordToOtelSpan, exportOtelBundle } = require("./otel");
const { buildOpsInsights, buildOpsOtelExport } = require("./insights");

describe("otel + ops insights", () => {
  const sample = [
    {
      id: "req_1",
      org_id: "o1",
      agent_id: "a1",
      status: "finalized",
      created_at: "2026-10-01T00:00:00.000Z",
      actual_usd: 0.02,
      reserved_usd: 1,
      latency_ms: 120,
      model_requested: "gpt-4o",
      model_routed: "gpt-4o-mini",
      provider: "openai",
      compression: {
        original_tokens: 40_000,
        retained_tokens: 5_000,
        ratio: 0.125,
        strategy: "neural_keep",
        dollars_avoided_est: 0.12,
        meta: {
          economics: {
            model_changed: true,
            unlocks_smaller_context_model: false,
            dollars_saved_est: 0.08,
            without_compress: { model: "gpt-4o" },
            with_compress: { model: "gpt-4o-mini" },
          },
          dollars_avoided_tokens_est: 0.04,
        },
      },
    },
    {
      id: "req_2",
      org_id: "o1",
      agent_id: "a1",
      status: "finalized",
      created_at: "2026-10-01T00:01:00.000Z",
      actual_usd: 0.01,
      latency_ms: 80,
      compression: {
        original_tokens: 100_000,
        retained_tokens: 7_000,
        dollars_avoided_est: 0.5,
        meta: {
          economics: {
            model_changed: true,
            unlocks_smaller_context_model: true,
            dollars_saved_est: 0.4,
            without_compress: { model: null, allow: false },
            with_compress: { model: "tiny", allow: true },
            original_tokens: 100_000,
            retained_tokens: 7_000,
          },
        },
      },
    },
  ];

  it("recordToOtelSpan exports compress attrs without ask bodies", () => {
    const span = recordToOtelSpan(sample[0]);
    assert.equal(span.name, "sc.control_plane.request");
    assert.equal(span.attributes["sc.request_id"], "req_1");
    assert.equal(span.attributes["sc.compress.original_tokens"], 40_000);
    assert.equal(span.attributes["sc.compress.route_model_changed"], true);
    assert.ok(!JSON.stringify(span).includes("REQUEST:"));
  });

  it("exportOtelBundle wraps resource spans", () => {
    const bundle = exportOtelBundle(sample);
    assert.equal(bundle.confidential, true);
    assert.equal(bundle.resourceSpans[0].scopeSpans[0].spans.length, 2);
  });

  it("buildOpsInsights headlines unlock + dollars moat", () => {
    const insights = buildOpsInsights(sample, { budget_usd: 1 });
    assert.ok(insights.headline.includes("unlocked") || insights.headline.includes("$"));
    assert.equal(insights.moat.unlock_count, 1);
    assert.equal(insights.moat.model_changed_count, 2);
    assert.ok(insights.moat.dollars_avoided_total_est > 0);
    assert.match(insights.moat.vs_litellm, /LiteLLM/);
  });

  it("buildOpsOtelExport filters by org", () => {
    const bundle = buildOpsOtelExport(
      [...sample, { id: "x", org_id: "other", status: "finalized" }],
      { org_id: "o1" }
    );
    assert.equal(bundle.resourceSpans[0].scopeSpans[0].spans.length, 2);
  });
});
