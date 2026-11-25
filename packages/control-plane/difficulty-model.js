"use strict";

/**
 * Learned prompt difficulty: how likely a strong model is to get a prompt right where a
 * cheaper model fails. A logistic regression over hashed word / bigram features and a few
 * shape features, trained offline on route-bench dev (RouterBench, see
 * scripts/bench_router_routerbench/). Scoring is a hash and a dot product: linear in the
 * prompt, no model call.
 *
 * difficultyScore(text) → probability in [0, 1]; 0.5 when no weights are installed.
 */

const fs = require("fs");
const path = require("path");

const WEIGHTS_PATH = path.join(__dirname, "difficulty-weights.json");
const MAX_CHARS = 8000;
const TOKEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{M}]+|\d+|[^\s\p{L}\p{N}]/gu;

let model;

function loadModel() {
  if (model !== undefined) return model;
  try {
    const raw = JSON.parse(fs.readFileSync(WEIGHTS_PATH, "utf8"));
    const weights = new Float64Array(raw.buckets);
    for (const [i, v] of raw.sparse) weights[i] = v;
    model = { buckets: raw.buckets, bias: raw.bias, dense: raw.dense, weights, version: raw.version };
  } catch (_) {
    model = null;
  }
  return model;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function denseFeatures(text, tokens) {
  const len = text.length || 1;
  const digits = (text.match(/\d/g) || []).length;
  const ops = (text.match(/[=+\-*/^<>%]/g) || []).length;
  const code = (text.match(/[{}();[\]]/g) || []).length;
  const lines = text.split("\n").length;
  return [
    Math.log1p(len) / 10,
    Math.log1p(tokens.length) / 10,
    digits / len,
    ops / len,
    code / len,
    Math.log1p(lines) / 5,
    (text.match(/\?/g) || []).length > 0 ? 1 : 0,
    /^\s*(?:\(?[A-D][).:]|[A-D]\s*[-:])\s/m.test(text) ? 1 : 0,
  ];
}

/** Hashed sparse features: unigrams and bigrams of lower-cased tokens. */
function hashedFeatures(text, buckets) {
  const lower = text.slice(0, MAX_CHARS).toLowerCase();
  const tokens = lower.match(TOKEN) || [];
  const counts = new Map();
  const add = (key) => {
    const i = fnv1a(key) % buckets;
    counts.set(i, (counts.get(i) || 0) + 1);
  };
  for (let i = 0; i < tokens.length; i += 1) {
    add(`u:${tokens[i]}`);
    if (i + 1 < tokens.length) add(`b:${tokens[i]} ${tokens[i + 1]}`);
  }
  // Binary-ish, length-normalised values so long prompts do not dominate.
  const norm = 1 / Math.sqrt(counts.size || 1);
  const sparse = [...counts.keys()].map((i) => [i, norm]);
  return { sparse, dense: denseFeatures(lower, tokens) };
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

function difficultyScore(text) {
  const m = loadModel();
  if (!m || typeof text !== "string" || !text.trim()) return 0.5;
  const { sparse, dense } = hashedFeatures(text, m.buckets);
  let z = m.bias;
  for (const [i, v] of sparse) z += m.weights[i] * v;
  for (let j = 0; j < dense.length; j += 1) z += (m.dense[j] || 0) * dense[j];
  return sigmoid(z);
}

function modelVersion() {
  const m = loadModel();
  return m ? m.version : null;
}

module.exports = { difficultyScore, hashedFeatures, sigmoid, modelVersion, WEIGHTS_PATH };
