/**
 * Unit tests for analytics aggregation (no Firebase / DOM).
 * Run: node web/assets/js/analytics-data.test.js
 */
const assert = require("assert");
const {
  isChartDay,
  aggregateUsage,
  bundleToSeries,
  demoBundle,
  escapeHtml,
} = require("./analytics-data.js");

assert.strictEqual(isChartDay("2026-08-11"), true);
assert.strictEqual(isChartDay("reconcile-2026-08"), false);
assert.strictEqual(isChartDay(""), false);

const demo = bundleToSeries(demoBundle());
assert.ok(demo.totalSaved > 0, "demo has savings");
assert.ok(demo.cut > 0 && demo.cut <= 100, "demo cut pct");
assert.strictEqual(demo.live, false);
assert.ok(demo.areaData.length === 30);

// Live payload with only agent totals (no by_day) must still fill KPIs + chart.
const agentOnly = aggregateUsage({
  keys: [{ id: "k1", name: "Coding agent", prefix: "sc_live_x" }],
  usage: {
    k1: {
      total_requests: 0,
      total_tokens_in: 0,
      total_tokens_saved: 0,
      by_day: {
        "reconcile-2026-08": { tokens_saved: 99999, tokens_in: 1, requests: 1 },
      },
    },
  },
  coding_agent_usage: {
    cursor: { requests: 12, tokens_in: 12639, tokens_saved: 6452, tokens_out: 6187 },
  },
  account_usage: null,
});
const series = bundleToSeries(agentOnly);
assert.strictEqual(series.live, true);
assert.strictEqual(series.totalSaved, 6452);
assert.strictEqual(series.totalIn, 12639);
assert.strictEqual(series.totalReq, 12);
assert.ok(series.cut >= 50 && series.cut <= 52, `cut=${series.cut}`);
assert.ok(
  series.areaData.some((d) => d.y > 0),
  "synthesizes a chart day when by_day empty / non-ISO only"
);
assert.ok(
  !series.areaData.some((d) => d.y === 99999),
  "ignores reconcile-* by_day keys"
);
assert.strictEqual(series.agents[0].label, "cursor");

// XSS escape
assert.strictEqual(escapeHtml(`<img src=x onerror=alert(1)>`), `&lt;img src=x onerror=alert(1)&gt;`);

// Key + account max
const withKeys = aggregateUsage({
  keys: [{ id: "k1", name: "Production" }],
  usage: {
    k1: {
      total_requests: 3,
      total_tokens_in: 1000,
      total_tokens_saved: 400,
      by_day: {
        [new Date().toISOString().slice(0, 10)]: {
          tokens_saved: 400,
          tokens_in: 1000,
          requests: 3,
        },
      },
    },
  },
  coding_agent_usage: {},
  account_usage: { month: "2026-08", requests: 10, tokens_in: 5000, tokens_saved: 2000, tokens_out: 3000 },
});
const s2 = bundleToSeries(withKeys);
assert.strictEqual(s2.totalSaved, 2000);
assert.strictEqual(s2.totalIn, 5000);
assert.strictEqual(s2.totalReq, 10);

console.log("analytics-data.test.js: ok");
