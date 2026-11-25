#!/usr/bin/env node
"use strict";
// Train the learned difficulty model on route-bench dev ONLY, then write
// packages/control-plane/difficulty-weights.json.
//
//   node scripts/bench_router_routerbench/train.js [--tune] [--buckets 65536] [--epochs 4] [--lr 0.5] [--l2 1e-6]
//
// --tune holds out 20% of dev (by id hash) and reports APGR there for each setting, so settings
// are chosen without looking at test or external.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const root = path.join(__dirname, "..", "..");
const { hashedFeatures, sigmoid, WEIGHTS_PATH } = require(path.join(root, "packages/control-plane/difficulty-model"));
const { loadRows, curve, summarize, mulberry32 } = require("./run");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

function train(rows, { buckets, epochs, lr, l2 }) {
  const feats = rows.map((r) => hashedFeatures(r.prompt, buckets));
  const ys = rows.map((r) => (r.strong > r.weak ? 1 : 0));
  const w = new Float64Array(buckets);
  const dense = new Array(feats[0].dense.length).fill(0);
  let bias = 0;
  const rand = mulberry32(11);
  const order = rows.map((_, i) => i);
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const rate = lr / (1 + epoch);
    for (const i of order) {
      const f = feats[i];
      let z = bias;
      for (const [k, v] of f.sparse) z += w[k] * v;
      for (let d = 0; d < dense.length; d += 1) z += dense[d] * f.dense[d];
      const g = sigmoid(z) - ys[i];
      bias -= rate * g;
      for (const [k, v] of f.sparse) w[k] -= rate * (g * v + l2 * w[k]);
      for (let d = 0; d < dense.length; d += 1) dense[d] -= rate * g * f.dense[d];
    }
  }
  return { w, dense, bias, buckets };
}

function scorer(m) {
  return (text) => {
    const f = hashedFeatures(text, m.buckets);
    let z = m.bias;
    for (const [k, v] of f.sparse) z += m.w[k] * v;
    for (let d = 0; d < m.dense.length; d += 1) z += m.dense[d] * f.dense[d];
    return sigmoid(z);
  };
}

function main() {
  const dev = loadRows().filter((r) => r.split === "dev");
  const base = { buckets: arg("--buckets", 65536), epochs: arg("--epochs", 4), lr: arg("--lr", 0.5), l2: arg("--l2", 1e-6) };
  if (process.argv.includes("--tune")) {
    const inner = (r) => crypto.createHash("sha256").update("inner" + r.id).digest()[0] % 5 === 0;
    const fit = dev.filter((r) => !inner(r));
    const val = dev.filter(inner);
    const grid = [];
    for (const buckets of [1 << 16, 1 << 18]) for (const epochs of [2, 4, 8]) for (const lr of [0.2, 0.5, 1]) for (const l2 of [0, 1e-6, 1e-5]) grid.push({ buckets, epochs, lr, l2 });
    const results = [];
    for (const h of grid) {
      const score = scorer(train(fit, h));
      const s = summarize(curve(val, val.map((r) => score(r.prompt))));
      results.push({ ...h, apgr: +s.apgr.toFixed(4), cpt80: s.cpt80 });
      console.error(JSON.stringify(results[results.length - 1]));
    }
    results.sort((a, b) => b.apgr - a.apgr);
    console.log("best on dev-val:", results.slice(0, 5));
    return;
  }
  const m = train(dev, base);
  const sparse = [];
  for (let i = 0; i < m.w.length; i += 1) if (Math.abs(m.w[i]) >= 1e-4) sparse.push([i, +m.w[i].toFixed(4)]);
  const out = {
    version: `rb-dev-${crypto.createHash("sha256").update(JSON.stringify(base) + dev.length).digest("hex").slice(0, 8)}`,
    trained_on: "route-bench dev (RouterBench 0-shot, in-distribution half; test and external never seen)",
    strong: "gpt-4-1106-preview", weak: "mixtral-8x7b-chat", hyper: base, n_train: dev.length,
    buckets: m.buckets, bias: +m.bias.toFixed(6), dense: m.dense.map((x) => +x.toFixed(6)), sparse,
  };
  fs.writeFileSync(WEIGHTS_PATH, JSON.stringify(out));
  console.log(`wrote ${WEIGHTS_PATH} (${sparse.length} weights, ${(fs.statSync(WEIGHTS_PATH).size / 1e6).toFixed(2)} MB)`);
}

main();
