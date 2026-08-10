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

async function compressAdaptive(context, query) {
  const E = getEngine();
  const neuralBoost = await loadNeuralBoost(context, query);
  return E.compressAdaptive(context, query, getModel(), neuralBoost ? { neuralBoost } : null);
}

async function compressCCR(context, query) {
  const E = getEngine();
  const neuralBoost = await loadNeuralBoost(context, query);
  return E.compressCCR(context, query, getModel(), {
    enableMarkers: true,
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
    const admin = require("firebase-admin");
    const { initFirebaseAdmin } = require("./auth");
    initFirebaseAdmin();
    const ownerUid = meta.ownerUid ? String(meta.ownerUid) : "";
    if (!ownerUid) {
      console.warn("CCR store skipped: missing ownerUid");
      return false;
    }
    const payload = {
      original: originalText,
      hash,
      owner_uid: ownerUid,
      key_id: meta.keyId ? String(meta.keyId) : null,
      stored_at: new Date().toISOString(),
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
