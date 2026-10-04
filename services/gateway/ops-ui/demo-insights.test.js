"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildDemoInsights, buildDemoRecords } = require("./demo-insights");

describe("ops-ui demo insights", () => {
  it("builds moat proof with unlocks and dollars", () => {
    const insights = buildDemoInsights({ budget_usd: 5 });
    assert.equal(insights.demo, true);
    assert.equal(insights.confidential, true);
    assert.ok(insights.moat.dollars_avoided_total_est > 0);
    assert.ok(insights.moat.unlock_count >= 1);
    assert.ok(insights.moat.model_changed_count >= 1);
    assert.ok(insights.records_preview.length >= 4);
    assert.match(insights.comparison.supercompress.routes_on, /post-keep/);
    assert.equal(insights.comparison.litellm.sees_route_unlock, false);
  });

  it("records never include ask/prompt bodies", () => {
    const blob = JSON.stringify(buildDemoRecords());
    assert.equal(blob.includes("REQUEST:"), false);
    assert.equal(blob.includes("user_ask"), false);
  });
});
