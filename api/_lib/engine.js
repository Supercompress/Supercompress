/**
 * Server-side compression — loads web compress-engine.js + model.json via vm.
 * Neural/BGE boost is opt-in (SC_NEURAL=1) and excluded from Vercel lambdas
 * (onnx/transformers exceed Hobby size limits). Default path is the local policy.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

let engine = null;
let model = null;

function projectRoot() {
  return path.join(__dirname, "..", "..");
}

function readAsset(localName, webRelPath) {
  const local = path.join(__dirname, localName);
  if (fs.existsSync(local)) return fs.readFileSync(local, "utf8");
  return fs.readFileSync(path.join(projectRoot(), "web/assets", webRelPath), "utf8");
}

function getEngine() {
  if (engine) return engine;

  const code = readAsset("compress-engine.js", "js/compress-engine.js");
  const sandbox = { globalThis: {}, window: undefined };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  engine = sandbox.globalThis.SuperCompressEngine;
  if (!engine) throw new Error("Failed to load SuperCompressEngine");
  return engine;
}

function getModel() {
  if (model) return model;
  model = JSON.parse(readAsset("model.json", "data/model.json"));
  return model;
}

async function loadNeuralBoost(context, query) {
  // Hosted Vercel functions exclude onnx/transformers (too large). Opt in only
  // when SC_NEURAL=1 and the optional deps are present.
  const on = process.env.SC_NEURAL === "1" || process.env.SC_NEURAL === "true";
  if (!on) return null;
  try {
    // Dynamic path so file-tracers don't always pull onnx into every lambda.
    const neuralPath = "./neural" + "-rerank.js";
    const neural = require(neuralPath);
    if (!neural.neuralEnabled()) return null;
    const E = getEngine();
    if (typeof E.prepareNeuralBlocks !== "function") return null;
    const prep = E.prepareNeuralBlocks(context, query, getModel());
    if (!prep.blocks || !prep.blocks.length) return null;
    return await neural.scoreBlocks(prep.question || query, prep.blocks);
  } catch (err) {
    console.warn("[supercompress] neural boost skipped:", err.message);
    return null;
  }
}

function compress(context, query, budgetRatio = 0.35) {
  const E = getEngine();
  return E.compressContext(context, query, budgetRatio, "SuperCompress", getModel());
}

function wrapNeuralKeepResult(context, query, remote) {
  const E = getEngine();
  const original = String(context || "");
  const compressed = String(remote.compressed_text || "");
  const original_tokens = Number(remote.original_tokens) || Math.max(1, Math.round(original.length / 4));
  const kept_tokens = Number(remote.kept_tokens) || Math.max(1, Math.round(compressed.length / 4));
  const tokens_removed = Math.max(0, original_tokens - kept_tokens);
  let answer_quality = 1;
  let important_kept_pct = 1;
  try {
    answer_quality = E.answerQualityScore(original, compressed, query);
    important_kept_pct = answer_quality;
  } catch {
    /* keep defaults */
  }
  return {
    original_text: original,
    compressed_text: compressed,
    original_tokens,
    kept_tokens,
    tokens_removed,
    tokens_saved: tokens_removed,
    tokens_saved_pct: Number(remote.tokens_saved_pct) || (1 - kept_tokens / Math.max(original_tokens, 1)) * 100,
    policy_name: remote.policy_name || "SuperCompress Neural Keep",
    mode: remote.mode || "neural-keep",
    answer_quality,
    important_kept_pct,
    compression_risk: important_kept_pct >= 0.98 ? "low" : important_kept_pct >= 0.9 ? "medium" : "high",
    line_annotations: [],
    preprocessor: "none",
    neural_keep_latency_ms: remote.neural_keep_latency_ms,
    neural_keep_lines_in: remote.lines_in,
    neural_keep_lines_kept: remote.lines_kept,
    neural_keep_threshold: remote.threshold,
  };
}

async function compressAdaptive(context, query) {
  try {
    const neuralKeep = require("./neural-keep");
    if (neuralKeep.neuralKeepEnabled()) {
      const remote = await neuralKeep.compressViaNeuralKeep(context, query);
      if (remote) return wrapNeuralKeepResult(context, query, remote);
    }
  } catch (err) {
    console.warn("[supercompress] neural-keep path failed:", err.message);
  }

  const E = getEngine();
  const neuralBoost = await loadNeuralBoost(context, query);
  // Hosted API never returns line_annotations — skip building them (big win on large dumps).
  return E.compressAdaptive(context, query, getModel(), {
    includeAnnotations: false,
    ...(neuralBoost ? { neuralBoost } : {}),
  });
}

async function compressCCR(context, query) {
  try {
    const neuralKeep = require("./neural-keep");
    if (neuralKeep.neuralKeepEnabled()) {
      const remote = await neuralKeep.compressViaNeuralKeep(context, query);
      if (remote) return wrapNeuralKeepResult(context, query, remote);
    }
  } catch (err) {
    console.warn("[supercompress] neural-keep CCR path failed:", err.message);
  }

  const E = getEngine();
  const neuralBoost = await loadNeuralBoost(context, query);
  return E.compressCCR(context, query, getModel(), {
    enableMarkers: true,
    includeAnnotations: false,
    neuralBoost: neuralBoost || undefined,
  });
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h = ((h << 5) - h) + c;
    h = h & h;
  }
  return Math.abs(h).toString(16).padStart(8, "0") + "_" + str.length.toString(16);
}

/** Tenant-scoped CCR doc path — prevents cross-tenant hash collisions / reads. */
function ccrOwnerDocPath(ownerUid, hash) {
  return `ccr/${ownerUid}/blocks/${hash}`;
}

/**
 * Persist a CCR block under the owning account.
 * @param {string} hash
 * @param {string} originalText
 * @param {{ ownerUid?: string, keyId?: string }} [meta]
 */
async function ccrStoreFirestore(hash, originalText, meta = {}) {
  try {
    const { skipFirestore } = require("./firebase-off");
    if (skipFirestore()) return false;
    const admin = require("firebase-admin");
    const { initFirebaseAdmin } = require("./auth");
    const { CCR_TTL_MS } = require("./retention");
    initFirebaseAdmin();
    const ownerUid = meta.ownerUid ? String(meta.ownerUid) : "";
    if (!ownerUid) {
      console.warn("CCR store skipped: missing ownerUid");
      return false;
    }
    const now = Date.now();
    const expireAt = admin.firestore.Timestamp.fromMillis(now + CCR_TTL_MS);
    const payload = {
      original: originalText,
      hash,
      owner_uid: ownerUid,
      key_id: meta.keyId ? String(meta.keyId) : null,
      stored_at: new Date(now).toISOString(),
      // Privacy: CCR stores removed original blocks for CCR_TTL_MS (same as replay).
      // Firestore TTL policy should target expire_at; retrieve also enforces this.
      expire_at: expireAt,
      ttl_ms: CCR_TTL_MS,
      token_count: originalText.split(/\s+/).length,
    };
    // Owner-scoped path (canonical). Never write a shared flat ccr/{hash} — that leaked across tenants.
    await admin.firestore().doc(ccrOwnerDocPath(ownerUid, hash)).set(payload);
    return true;
  } catch (err) {
    console.warn("CCR store failed:", err.message);
    return false;
  }
}

/** Persist CCR payloads in Firestore (owner-scoped). */
async function storeCcrBlocks(ccr, fullText, meta = {}) {
  const hashes = Array.isArray(ccr?.marker_hashes) ? ccr.marker_hashes : [];
  const storedHashes = [];
  const E = getEngine();

  for (const hash of hashes) {
    const original = E.ccrRetrieve(hash);
    if (original && (await ccrStoreFirestore(hash, original, meta))) storedHashes.push(hash);
  }

  const fullStored = Boolean(ccr?.hash) && (await ccrStoreFirestore(ccr.hash, fullText, meta));
  return {
    stored: fullStored || storedHashes.length > 0,
    stored_hashes: storedHashes,
    full_stored: fullStored,
  };
}

function wrapCompressedForCache(compressedText, query) {
  const E = getEngine();
  return E.cacheWrap(compressedText, query);
}

module.exports = {
  compress,
  compressAdaptive,
  compressCCR,
  getEngine,
  getModel,
  simpleHash,
  ccrOwnerDocPath,
  ccrStoreFirestore,
  storeCcrBlocks,
  wrapCompressedForCache,
};
