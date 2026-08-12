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
  fakeKeysPayload,
  escapeHtml,
} = require("./analytics-data.js");

assert.strictEqual(isChartDay("2026-08-11"), true);
assert.strictEqual(isChartDay("reconcile-2026-08"), false);
assert.strictEqual(isChartDay(""), false);

const fake = fakeKeysPayload();
assert.strictEqual(fake._fake, true);
assert.ok(fake.keys.length >= 3);
const fakeSeries = bundleToSeries(aggregateUsage(fake));
assert.ok(fakeSeries.totalSaved > 100000, "fake usage has meaty savings");
assert.ok(fakeSeries.cut > 40 && fakeSeries.cut < 70, `fake cut=${fakeSeries.cut}`);
assert.ok(fakeSeries.areaData.some((d) => d.y > 0));
assert.ok(fakeSeries.agents.some((a) => a.label === "Cursor"));
assert.ok(fakeSeries.keys.some((k) => k.label === "Production"));

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

// Month meter ahead of partial by_day — chart catches up on today.
const partial = aggregateUsage({
  keys: [{ id: "k1", name: "Production" }],
  usage: {
    k1: {
      total_requests: 10,
      total_tokens_in: 100000,
      total_tokens_saved: 50000,
      by_day: {
        [new Date().toISOString().slice(0, 10)]: {
          tokens_saved: 10000,
          tokens_in: 20000,
          requests: 2,
        },
      },
    },
  },
  coding_agent_usage: {},
  account_usage: {
    month: "2026-08",
    requests: 100,
    tokens_in: 500000,
    tokens_saved: 250000,
    tokens_out: 250000,
  },
});
const s3 = bundleToSeries(partial);
assert.strictEqual(s3.totalSaved, 250000);
assert.strictEqual(
  s3.areaData.reduce((s, d) => s + d.y, 0),
  250000,
  "chart area matches month meter after gap fold"
);
assert.ok(
  s3.activeDays >= 2,
  "gap spread across multiple days, not a single today spike"
);
const todayIso = new Date().toISOString().slice(0, 10);
const todayY = s3.areaData.find((d) => d.iso === todayIso)?.y || 0;
assert.ok(
  todayY < 250000,
  "today should not hold the entire month gap alone"
);

assert.ok(typeof require("./analytics-data.js").agentLogoSrc === "function");
assert.strictEqual(require("./analytics-data.js").agentLogoSrc("Cursor"), "/assets/logos/cursor.svg");
assert.ok(require("./analytics-data.js").agentLogoHtml("Claude Code").includes("claude.png"));

console.log("analytics-data.test.js: ok");
