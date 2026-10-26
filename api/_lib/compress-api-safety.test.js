const assert = require("node:assert/strict");
const { test, after } = require("node:test");
const Module = require("node:module");
const { sanitizeReplayResponse } = require("./billing-ledger");
const { countTokens } = require("./compression-safety");

let candidate;
let wrapped;
let billed;
let recordedUsage;
let engineQuery;
let replay;
let stores = 0;
let wraps = 0;
let stored = true;
const rateLimit = () => ({ allowed: true, remaining: 100, backend: "firestore" });
const mocks = {
  "../_lib/http": {
    json: (res, status, body) => ({ status, body }),
    jsonWithRateLimit: (res, status, body) => ({ status, body }),
    checkRateLimit: rateLimit,
    clientIp: () => "127.0.0.1",
    readBody: (req) => req.body,
  },
  "../_lib/rate-limit-durable": { enforceRateLimits: async () => rateLimit() },
  "../_lib/auth": { bearerToken: () => null },
  "../_lib/keys": { KEY_PREFIX: "sc_test_" },
  "../_lib/firebase-key-store": {
    authenticateKey: async () => ({ user: {}, owner: { customClaims: {} }, ownerUid: "test-owner" }),
    recordUsage: async (user, owner, result, options) => { billed = { result, response: options.response }; return recordedUsage; },
  },
  "../_lib/engine": {
    compressAdaptive: async (context, query) => { engineQuery = query; return candidate; },
    compressCCR: async (context, query) => { engineQuery = query; return candidate; },
    storeCcrBlocks: async () => { stores++; return { stored, stored_hashes: [], full_stored: stored }; },
    wrapCompressedForCache: () => { wraps++; return { wrapped }; },
  },
  "../_lib/stripe": { isComped: () => true },
  "../_lib/billing-ledger": {
    sanitizeRequestId: (value) => value || null,
    computeCompressFingerprint: () => "synthetic-fixture",
    reserveIdempotencyLease: async () => replay
      ? { status: "completed", data: { response: replay } }
      : { status: "reserved" },
  },
  "../_lib/cp-hooks": { maybeAttachControlPlane: () => {} },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename === require.resolve("../v1/compress") && mocks[request]) return mocks[request];
  return originalLoad.call(this, request, parent, isMain);
};
const handler = require("../v1/compress");
after(() => { Module._load = originalLoad; });

async function request(context, options = {}) {
  billed = null;
  stores = 0;
  wraps = 0;
  const response = await handler({
    method: "POST",
    headers: { "x-api-key": "sc_test_key", ...(replay ? { "idempotency-key": "test-replay" } : {}) },
    body: { context, query: "Preserve evidence", log: false, ...options },
  }, { setHeader() {} });
  assert.equal(response.status, 200);
  return response.body;
}

function assertPassthrough(body, context) {
  assert.equal(body.compressed_text, context);
  assert.equal(body.mode, "passthrough");
  assert.equal(body.tokens_saved, 0);
  assert.equal(body.tokens_saved_pct, 0);
  assert.equal(body.kv_savings_pct, 0);
  assert.equal(body.kept_tokens, countTokens(context));
  assert.equal(body.cache_prefix_applied, false);
  assert.equal(body.ccr, null);
  assert.ok(body.warnings.length);
  if (billed) {
    assert.equal(billed.result.compressed_text, context);
    assert.equal(billed.result.tokens_saved, 0);
    assert.equal(billed.response.compressed_text, context);
  }
}

test("API rejects collapse, bloat and 3% savings before billing or CCR/cache decoration", async () => {
  const context = Array(11376).fill("evidence").join(" ");
  for (const text of ["# SuperCompress context digest", context + " bloat", Array(11035).fill("evidence").join(" ")]) {
    candidate = { compressed_text: text, original_tokens: 11376, kept_tokens: 20, tokens_saved_pct: 99.8 };
    assertPassthrough(await request(context, { ccr: true, cache_prefix: true }), context);
    assert.ok(billed);
    assert.equal(stores, 0);
    assert.equal(wraps, 0);
  }
});

test("API counts final cache wrapper overhead and rejects wrapper-induced bloat", async () => {
  const context = Array(100).fill("evidence").join(" ");
  candidate = { compressed_text: Array(50).fill("evidence").join(" ") };
  wrapped = candidate.compressed_text + " cached";
  const accepted = await request(context, { cache_prefix: true });
  assert.equal(accepted.compressed_text, wrapped);
  assert.equal(accepted.kept_tokens, 51);
  assert.equal(accepted.tokens_saved, 49);
  assert.equal(billed.result.kept_tokens, 51);
  assert.equal(accepted.cache_prefix_applied, true);
  wrapped = context + " bloat";
  assertPassthrough(await request(context, { cache_prefix: true }), context);
});

test("API rejects CCR marker overhead that erases meaningful savings", async () => {
  const context = Array(100).fill("evidence").join(" ");
  candidate = { compressed_text: Array(95).fill("evidence").join(" "), ccr: { hash: "synthetic", markers_count: 0 } };
  assertPassthrough(await request(context, { ccr: true }), context);
  assert.equal(stores, 1);
});

test("API rechecks output after failed CCR persistence strips markers", async () => {
  const context = Array(11376).fill("evidence").join(" ");
  candidate = {
    compressed_text: "# Digest\n" + Array(20).fill("[SC-Retrieve: synthetic]").join("\n"),
    ccr: { hash: "synthetic", markers_count: 20 },
  };
  stored = false;
  try {
    assertPassthrough(await request(context, { ccr: true }), context);
    assert.equal(stores, 1);
  } finally {
    stored = true;
  }
});

test("API safely replays previously stored unsafe compression without rebilling", async () => {
  const context = Array(11376).fill("evidence").join(" ");
  replay = { compressed_text: "# Digest", tokens_saved_pct: 99.8, ccr: { hash: "stale" }, cache_prefix_applied: true };
  try {
    const body = await request(context);
    assertPassthrough(body, context);
    assert.equal(body.idempotent_replay, true);
    assert.equal(billed, null);
  } finally {
    replay = null;
  }
});

test("persisted safety replays preserve the original fallback and warning", async () => {
  const context = Array(11376).fill("evidence").join(" ");
  candidate = { compressed_text: "# Header" };
  const first = await request(context);
  replay = sanitizeReplayResponse(first);
  try {
    const second = await request(context);
    assert.equal(second.fallback_reason, first.fallback_reason);
    assert.deepEqual(second.compression_safety, first.compression_safety);
    assert.ok(first.warnings.every(warning => second.warnings.includes(warning)));
    assert.equal(billed, null);
  } finally {
    replay = null;
  }
});

test("API reports exhaustion from durable recorded usage on successful requests", async () => {
  const context = Array(100).fill("evidence").join(" ");
  candidate = { compressed_text: Array(50).fill("evidence").join(" ") };
  recordedUsage = { tokens_in: 8886094 };
  try {
    const body = await request(context);
    assert.equal(body.free_tokens_remaining, 0);
    assert.equal(body.tokens_used_this_period, 8886094);
    assert.match(body.warnings.join("\n"), /allowance is exhausted/);
  } finally {
    recordedUsage = undefined;
  }
});

test("API forwards raw dump mode without inventing a query", async () => {
  const context = Array(100).fill("evidence").join(" ");
  candidate = { compressed_text: Array(50).fill("evidence").join(" ") };
  for (const query of [undefined, "", "   "]) {
    await request(context, { query });
    assert.equal(engineQuery, "");
  }
  await request(context, { query: "Preserve specific findings" });
  assert.equal(engineQuery, "Preserve specific findings");
});
