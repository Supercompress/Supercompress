#!/usr/bin/env node
"use strict";
// route-bench: score routing decisions against what real models actually got right.
//
// Data: RouterBench 0-shot (withmartian/routerbench, 36,497 prompts). Each prompt carries the
// recorded score of 11 models. A router here picks strong (GPT-4-1106) or weak (Mixtral-8x7B)
// for each prompt; quality is the picked model's recorded score. No model calls are made.
//
// Protocol (same rules as compress-bench):
//   dev       half of the in-distribution prompts (MMLU, HellaSwag, GSM8K, ARC, Winogrande).
//             Tune and train here only.
//   test      the other half, by salted hash of the prompt id. Score once per router version.
//   external  every other task family (MBPP code, MT-Bench, summaries, Chinese tasks …). Never
//             tuned on; tests whether a router generalises to task kinds it never saw.
//
// Metrics (RouteLLM): sweep each router's threshold from 0% to 100% strong calls.
//   PGR(k)  share of the weak→strong quality gap recovered at k% strong calls.
//   APGR    mean PGR over k. Random routing scores 0.5 by construction; the oracle is the ceiling.
//   CPT(x)  strong-call share needed to recover x of the gap (lower is better).
// 95% CIs come from a prompt bootstrap.
//
//   ROUTERBENCH_JSONL=… node scripts/bench_router_routerbench/run.js [--split dev|test|external|all] [--json]

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const root = path.join(__dirname, "..", "..");
const { classifyRequest } = require(path.join(root, "packages/control-plane/request-classifier"));
const { difficultyScore } = require(path.join(root, "packages/control-plane/difficulty-model"));

const STRONG = "gpt-4-1106-preview";
const WEAK = "mistralai/mixtral-8x7b-chat";
const IN_DIST = /^(?:mmlu-|hellaswag$|grade-school-math$|arc-challenge$|winogrande$)/;
const SALT = "route-bench-v1";
const DATA = process.env.ROUTERBENCH_JSONL ||
  path.join(process.env.HOME || "", "Downloads/sc-bench-local/routerbench/routerbench_0shot.jsonl");

function splitOf(row) {
  if (!IN_DIST.test(row.eval)) return "external";
  const h = crypto.createHash("sha256").update(SALT + row.id).digest()[0];
  return h % 2 === 0 ? "dev" : "test";
}

function loadRows() {
  if (!fs.existsSync(DATA)) {
    console.error(`RouterBench data not found at ${DATA}. Set ROUTERBENCH_JSONL (see README.md here).`);
    process.exit(2);
  }
  return fs.readFileSync(DATA, "utf8").split("\n").filter(Boolean).map((line) => {
    const r = JSON.parse(line);
    return { id: r.id, eval: r.eval, prompt: r.prompt, strong: r.score[STRONG], weak: r.score[WEAK],
      strongCost: r.cost[STRONG], weakCost: r.cost[WEAK], split: splitOf(r) };
  }).filter((r) => Number.isFinite(r.strong) && Number.isFinite(r.weak));
}

// Curve from scores: route the highest-scoring prompts to strong first. Ties are routed as a
// group with linear interpolation (the expected value of random tie-breaking).
function curve(rows, scores, weights) {
  const w = weights || rows.map(() => 1);
  const order = rows.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const total = w.reduce((s, x) => s + x, 0);
  const qWeak = rows.reduce((s, r, i) => s + w[i] * r.weak, 0) / total;
  const qStrong = rows.reduce((s, r, i) => s + w[i] * r.strong, 0) / total;
  const points = [[0, qWeak]];
  let cum = 0, gain = 0;
  for (let g = 0; g < order.length;) {
    let h = g;
    while (h < order.length && scores[order[h]] === scores[order[g]]) h += 1;
    for (let k = g; k < h; k += 1) {
      const i = order[k];
      cum += w[i]; gain += w[i] * (rows[i].strong - rows[i].weak);
    }
    points.push([cum / total, qWeak + gain / total]);
    g = h;
  }
  return { points, qWeak, qStrong };
}

function summarize(c, grid = 200) {
  const gap = c.qStrong - c.qWeak;
  const at = (x) => {
    const p = c.points;
    for (let j = 1; j < p.length; j += 1) {
      if (x <= p[j][0] + 1e-12) {
        const [x0, y0] = p[j - 1], [x1, y1] = p[j];
        return x1 === x0 ? y1 : y0 + (y1 - y0) * (x - x0) / (x1 - x0);
      }
    }
    return p[p.length - 1][1];
  };
  let apgr = 0;
  const pgr = [];
  for (let k = 0; k <= grid; k += 1) { const v = (at(k / grid) - c.qWeak) / gap; pgr.push(v); }
  for (let k = 0; k < grid; k += 1) apgr += (pgr[k] + pgr[k + 1]) / 2 / grid;
  const cpt = (target) => { for (let k = 0; k <= grid; k += 1) if (pgr[k] >= target) return k / grid; return 1; };
  return { apgr, cpt50: cpt(0.5), cpt80: cpt(0.8), qWeak: c.qWeak, qStrong: c.qStrong };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrap(rows, scores, reps = 200) {
  const rand = mulberry32(7);
  const out = [];
  for (let b = 0; b < reps; b += 1) {
    const w = new Array(rows.length).fill(0);
    for (let i = 0; i < rows.length; i += 1) w[Math.floor(rand() * rows.length)] += 1;
    out.push(summarize(curve(rows, scores, w)).apgr);
  }
  out.sort((a, b) => a - b);
  return [out[Math.floor(reps * 0.025)], out[Math.floor(reps * 0.975)]];
}

// Cost at the threshold where the router recovers 80% of the gap, relative to always-strong.
function costAt(rows, scores, share) {
  const order = rows.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const k = Math.round(share * rows.length);
  let cost = 0;
  order.forEach((i, rank) => { cost += rank < k ? rows[i].strongCost : rows[i].weakCost; });
  return cost / rows.reduce((s, r) => s + r.strongCost, 0);
}

const ARMS = {
  random: () => 0,
  length: (r) => r.prompt.length,
  "sc-router": (r) => classifyRequest({ messages: [{ role: "user", content: r.prompt }] }).tier,
  "learned-only": (r) => difficultyScore(r.prompt),
  oracle: (r) => r.strong - r.weak,
};

function main() {
  const args = process.argv.slice(2);
  const only = args.includes("--split") ? args[args.indexOf("--split") + 1] : "all";
  const asJson = args.includes("--json");
  const rows = loadRows();
  const splits = only === "all" ? ["dev", "test", "external"] : [only];
  const report = {};
  for (const split of splits) {
    const sub = rows.filter((r) => r.split === split);
    report[split] = { n: sub.length, arms: {} };
    for (const [name, fn] of Object.entries(ARMS)) {
      const scores = sub.map(fn);
      const s = summarize(curve(sub, scores));
      const ci = name === "random" || name === "oracle" ? null : bootstrap(sub, scores);
      report[split].arms[name] = {
        apgr: +s.apgr.toFixed(4), apgr_ci95: ci && ci.map((x) => +x.toFixed(4)),
        cpt50: s.cpt50, cpt80: s.cpt80, cost_at_cpt80: +costAt(sub, scores, s.cpt80).toFixed(3),
      };
      report[split].quality = { weak: +s.qWeak.toFixed(4), strong: +s.qStrong.toFixed(4) };
    }
  }
  if (asJson) { console.log(JSON.stringify(report, null, 2)); return; }
  for (const [split, r] of Object.entries(report)) {
    console.log(`\n== ${split} (n=${r.n}) · weak ${r.quality.weak} → strong ${r.quality.strong}`);
    console.table(Object.fromEntries(Object.entries(r.arms).map(([k, v]) => [k, {
      APGR: v.apgr, "95% CI": v.apgr_ci95 ? v.apgr_ci95.join("–") : "", "CPT(50%)": v.cpt50, "CPT(80%)": v.cpt80, "cost@CPT80": v.cost_at_cpt80,
    }])));
  }
}

if (require.main === module) main();
module.exports = { mulberry32, loadRows, curve, summarize, splitOf, ARMS, STRONG, WEAK };
