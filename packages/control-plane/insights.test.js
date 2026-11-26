"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { recordToOtelSpan, exportOtelBundle, fromAttributes } = require("./otel");
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
      model_requested: "gpt-6.1-sol",
      model_routed: "gpt-6-luna",
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
            without_compress: { model: "gpt-6.1-sol" },
            with_compress: { model: "gpt-6-luna" },
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
    const attrs = fromAttributes(span.attributes);
    assert.equal(span.name, "sc.control_plane.request");
    assert.equal(attrs["sc.request_id"], "req_1");
    assert.equal(attrs["sc.compress.original_tokens"], 40_000);
    assert.equal(attrs["sc.compress.route_model_changed"], true);
    assert.ok(!JSON.stringify(span).includes("REQUEST:"));
  });

  it("exportOtelBundle wraps resource spans", () => {
    const bundle = exportOtelBundle(sample);
    assert.equal(bundle.resourceSpans[0].scopeSpans[0].spans.length, 2);
    assert.deepEqual(Object.keys(bundle), ["resourceSpans"]);
  });

  it("exportOtelBundle is valid OTLP/JSON (typed attributes, enum kind/status, nano strings)", () => {
    const bundle = exportOtelBundle([...sample, { id: "e", error_class: "upstream", error_message: "boom", created_at: "2026-11-04T00:00:00Z", latency_ms: 12 }]);
    const rs = bundle.resourceSpans[0];
    assert.ok(Array.isArray(rs.resource.attributes));
    assert.deepEqual(rs.resource.attributes.find((a) => a.key === "service.name").value, { stringValue: "supercompress-control-plane" });
    for (const span of rs.scopeSpans[0].spans) {
      assert.match(span.traceId, /^[0-9a-f]{32}$/);
      assert.match(span.spanId, /^[0-9a-f]{16}$/);
      assert.equal(span.kind, 2);
      assert.match(span.startTimeUnixNano, /^\d+$/);
      assert.match(span.endTimeUnixNano, /^\d+$/);
      assert.ok([1, 2].includes(span.status.code));
      for (const kv of span.attributes) {
        assert.equal(typeof kv.key, "string");
        const kinds = Object.keys(kv.value);
        assert.equal(kinds.length, 1);
        assert.ok(["stringValue", "intValue", "doubleValue", "boolValue"].includes(kinds[0]));
        if (kinds[0] === "intValue") assert.match(kv.value.intValue, /^-?\d+$/);
      }
    }
    const err = rs.scopeSpans[0].spans[2];
    assert.deepEqual(err.status, { code: 2, message: "boom" });
    assert.equal(err.startTimeUnixNano, "1793750400000000000");
    assert.equal(err.endTimeUnixNano, "1793750400012000000");
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
