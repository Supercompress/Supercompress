#!/usr/bin/env node
/**
 * Controlled runway simulation (seeded, deterministic).
 *
 * A heavy agent works back-to-back steps through many 5h windows. Before each
 * step it asks the real planner (planRunway) what to do, with history points
 * quantized to whole percents the way Codex reports them. The provider cuts the
 * session off at 100%; a cutoff without a checkpoint before that step = lost
 * work.
 *
 * Compares limitcheck's thresholds (policy "conservative") with "max".
 * Pass criteria: max uses ≥ 98% of each binding 5h window on average, loses at
 * most one step to an unforeseeable spike across 60 windows (vs. most windows
 * without landing), and never does worse than conservative on a light workload.
 */
const assert = require("assert");
const { normalizeSnapshot } = require("../src/limits/normalize");
const { planRunway } = require("../src/limits/runway");

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WINDOW = 300;
const START = Date.parse("2026-10-21T00:00:00.000Z");
const iso = (min) => new Date(START + min * 60000).toISOString();

function runWindow(policy, rand, workload, { landing = true } = {}) {
  let t = 0;
  let used = 0;
  let steps = 0;
  let cuts = 0;
  let lost = 0;
  let checkpoints = 0;
  let stoppedEarlyAt = null;
  const points = [];
  const resetAt = iso(WINDOW);

  while (t < WINDOW) {
    const reported = Math.floor(used); // providers report whole percents
    points.push({ t: iso(t), w: [{ n: "5h window", u: reported, r: resetAt }, { n: "weekly", u: 20, r: iso(5 * 1440) }] });
    const snapshot = normalizeSnapshot({
      provider: "codex",
      checkedAt: iso(t),
      windows: [
        { name: "5h", usedPercent: reported, windowMinutes: WINDOW, resetAt, ...(used >= 100 ? { exhausted: true } : {}) },
        { name: "weekly", usedPercent: 20, windowMinutes: 10080, resetAt: iso(5 * 1440) },
      ],
    });
    const plan = planRunway(snapshot, { points, now: new Date(iso(t)), policy });
    if (!plan.proceed) {
      if (used < 100 && stoppedEarlyAt === null) stoppedEarlyAt = used;
      break; // idle until reset
    }
    let checkpointed = false;
    if (plan.action === "land" && landing) {
      checkpoints += 1;
      checkpointed = true;
      t += 1;
      used = Math.min(100, used + 0.1);
    }
    const duration = workload.minDur + rand() * (workload.maxDur - workload.minDur);
    let cost = workload.minCost + rand() * (workload.maxCost - workload.minCost);
    if (rand() < workload.spikeChance) cost *= 2; // occasional big step
    if (t + duration > WINDOW) break;
    t += duration;
    if (used + cost > 100) {
      cuts += 1;
      if (!checkpointed) lost += 1;
      used = 100;
      continue;
    }
    used += cost;
    steps += 1;
  }
  return { used: Math.min(100, used), steps, cuts, lost, checkpoints, stoppedEarlyAt };
}

function simulate(policy, workload, { windows = 60, seed = 42, landing = true } = {}) {
  const rand = mulberry32(seed);
  const rows = Array.from({ length: windows }, () => runWindow(policy, rand, workload, { landing }));
  const avg = (k) => rows.reduce((a, r) => a + r[k], 0) / rows.length;
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  return {
    policy: landing ? policy : `${policy} (no landing)`,
    utilization: Math.round(avg("used") * 10) / 10,
    stepsPerWindow: Math.round(avg("steps") * 10) / 10,
    cutoffs: sum("cuts"),
    lostWork: sum("lost"),
    checkpointsPerWindow: Math.round(avg("checkpoints") * 10) / 10,
  };
}

const HEAVY = { minDur: 3, maxDur: 8, minCost: 1, maxCost: 4, spikeChance: 0.08 };
const LIGHT = { minDur: 6, maxDur: 14, minCost: 0.3, maxCost: 1.2, spikeChance: 0.05 };

const results = [];
for (const [name, workload] of [["heavy (cap binds)", HEAVY], ["light (cap never binds)", LIGHT]]) {
  for (const policy of ["conservative", "balanced", "max"]) {
    results.push({ workload: name, ...simulate(policy, workload) });
  }
  results.push({ workload: name, ...simulate("max", workload, { landing: false }) });
}
console.table(results);

const heavy = Object.fromEntries(results.filter((r) => r.workload.startsWith("heavy")).map((r) => [r.policy, r]));
const light = Object.fromEntries(results.filter((r) => r.workload.startsWith("light")).map((r) => [r.policy, r]));

assert.ok(heavy.max.utilization >= 98, `max should use ≥98% of a binding 5h window, got ${heavy.max.utilization}`);
assert.ok(heavy.conservative.utilization <= 92, `conservative baseline should stop near 90%, got ${heavy.conservative.utilization}`);
// A step larger than anything seen earlier in the window cannot be predicted;
// allow at most one such loss across the 60 windows, and require landing to
// cut losses vs. draining without checkpoints.
assert.ok(heavy.max.lostWork <= 1, `max should checkpoint before (almost) every cutoff, lost ${heavy.max.lostWork}`);
assert.ok(heavy.max.lostWork < heavy["max (no landing)"].lostWork / 5, "landing prevents most cutoff losses");
assert.ok(heavy.max.stepsPerWindow > heavy.conservative.stepsPerWindow, "max completes more work per window");
assert.ok(light.max.stepsPerWindow >= light.conservative.stepsPerWindow, "no regression when the cap never binds");
assert.strictEqual(light.max.checkpointsPerWindow, 0, "no landing noise when the window is not near its cap");

const gain = ((heavy.max.stepsPerWindow / heavy.conservative.stepsPerWindow - 1) * 100).toFixed(1);
console.log(`\nrunway-sim: max uses ${heavy.max.utilization}% vs ${heavy.conservative.utilization}% (limitcheck thresholds) — +${gain}% steps per 5h window, ${heavy.max.lostWork} lost to cutoffs.`);
