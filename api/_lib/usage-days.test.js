/**
 * Run: node api/_lib/usage-days.test.js
 */
const assert = require("assert");
const {
  bumpPackedDays,
  expandPackedDays,
  daysFromRecentBilling,
  fillMonthGap,
  monthDayKeys,
  accountDaysFromClaims,
} = require("./usage-days");

const packed = bumpPackedDays(null, {
  day: "2026-08-13",
  month: "2026-08",
  tokens_in: 1000,
  tokens_saved: 400,
  requests: 2,
});
assert.strictEqual(packed.m, "2026-08");
assert.deepStrictEqual(packed.d["13"], [1000, 400, 2]);

const again = bumpPackedDays(packed, {
  day: "2026-08-13",
  month: "2026-08",
  tokens_in: 50,
  tokens_saved: 20,
  requests: 1,
});
assert.deepStrictEqual(again.d["13"], [1050, 420, 3]);

const expanded = expandPackedDays(again, "2026-08");
assert.strictEqual(expanded["2026-08-13"].tokens_in, 1050);
assert.strictEqual(expanded["2026-08-13"].tokens_saved, 420);
assert.ok(!expandPackedDays({ m: "2026-07", d: again.d }, "2026-07")["2026-08-13"]);

const fromRecent = daysFromRecentBilling(
  [{ tin: 80, ts: 30, tout: 50, t: Date.parse("2026-08-02T15:00:00.000Z") }],
  "2026-08"
);
assert.strictEqual(fromRecent["2026-08-02"].tokens_in, 80);

const keys = monthDayKeys("2026-08", "2026-08-10");
assert.strictEqual(keys.length, 10);
assert.strictEqual(keys[0], "2026-08-01");
assert.strictEqual(keys[9], "2026-08-10");

const filled = fillMonthGap({}, { tokens_in: 10000, tokens_saved: 4000, requests: 20 }, "2026-08", "2026-08-10");
assert.strictEqual(filled.source, "reconstructed");
const sumIn = Object.values(filled.by_day).reduce((s, d) => s + d.tokens_in, 0);
assert.strictEqual(sumIn, 10000);
assert.ok(filled.by_day["2026-08-01"].tokens_in > 0);
assert.ok(filled.by_day["2026-08-10"].tokens_in > 0);

const claims = accountDaysFromClaims(
  {
    sc_usage: { month: "2026-08", tokens_in: 5000, tokens_saved: 2000, requests: 5, d: { "03": [1000, 400, 1] } },
  },
  "2026-08"
);
assert.ok(claims.by_day["2026-08-03"].tokens_in >= 1000);
assert.ok(Object.values(claims.by_day).reduce((s, d) => s + d.tokens_in, 0) >= 5000);


const mixed = fillMonthGap(
  {
    "2026-08-03": { tokens_in: 1000, tokens_saved: 400, tokens_out: 600, requests: 1 },
    "2026-08-09": { tokens_in: 2000, tokens_saved: 800, tokens_out: 1200, requests: 2 },
  },
  { tokens_in: 10000, tokens_saved: 4000, requests: 20 },
  "2026-08",
  "2026-08-10"
);
assert.strictEqual(mixed.source, "mixed");
assert.strictEqual(mixed.by_day["2026-08-01"]?.tokens_saved || 0, 0, "idle days stay zero");
assert.ok(mixed.by_day["2026-08-03"].tokens_saved > 400);
assert.ok(mixed.by_day["2026-08-09"].tokens_saved > 800);
const mixedSum = Object.values(mixed.by_day).reduce((s, d) => s + d.tokens_saved, 0);
assert.strictEqual(mixedSum, 4000);

console.log("usage-days.test.js: ok");
