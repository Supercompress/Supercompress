"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

function mockFetch(handler) {
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/ready")) {
      return { ok: true, status: 200, json: async () => ({ ready: true }) };
    }
    return handler(u, opts || {});
  };
}

describe("neural-keep client", () => {
  const origFetch = global.fetch;
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env.SC_NEURAL_KEEP_URL = "https://neural.example.test";
    process.env.SC_NEURAL_KEEP_SECRET = "sekret";
    delete process.env.SC_NEURAL_KEEP;
    delete require.cache[require.resolve("./neural-keep")];
  });

  afterEach(() => {
    global.fetch = origFetch;
    process.env = { ...origEnv };
    delete require.cache[require.resolve("./neural-keep")];
  });

  it("disabled when URL missing", async () => {
    delete process.env.SC_NEURAL_KEEP_URL;
    const mod = require("./neural-keep");
    assert.equal(mod.neuralKeepEnabled(), false);
    const out = await mod.compressViaNeuralKeep("ctx", "q");
    assert.equal(out, null);
  });

  it("disabled when SC_NEURAL_KEEP=0", async () => {
    process.env.SC_NEURAL_KEEP = "0";
    const mod = require("./neural-keep");
    assert.equal(mod.neuralKeepEnabled(), false);
  });

  it("posts context/query and maps response", async () => {
    let seenUrl = "";
    let seenBody = null;
    let seenAuth = "";
    mockFetch(async (url, opts) => {
      seenUrl = url;
      seenBody = JSON.parse(opts.body);
      seenAuth = opts.headers.Authorization;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          compressed_text: "kept line",
          original_tokens: 100,
          kept_tokens: 20,
          tokens_saved_pct: 80,
          policy_name: "SuperCompress Neural Keep",
          mode: "neural-keep",
          latency_ms: 42,
          lines_in: 10,
          lines_kept: 2,
          threshold: 0.12,
          checkpoint: "sc-keep-crossencoder-v4-large",
          params_m: 395.83,
          weights_match_expected: true,
        }),
      };
    });

    const mod = require("./neural-keep");
    const out = await mod.compressViaNeuralKeep("long\ncontext", "why fail?");
    assert.ok(out);
    assert.equal(seenUrl, "https://neural.example.test/v1/compress");
    assert.equal(seenAuth, "Bearer sekret");
    assert.equal(seenBody.query, "why fail?");
    assert.equal(out.compressed_text, "kept line");
    assert.equal(out.tokens_saved_pct, 80);
    assert.equal(out.mode, "neural-keep");
    assert.equal(out.checkpoint, "sc-keep-crossencoder-v4-large");
    assert.equal(out.weights_match_expected, true);
  });

  it("retries once on 503 busy then succeeds", async () => {
    let n = 0;
    mockFetch(async () => {
      n += 1;
      if (n === 1) {
        return {
          ok: false,
          status: 503,
          statusText: "Unavailable",
          headers: { get: () => "0" },
          json: async () => ({ detail: "busy" }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          compressed_text: "kept",
          original_tokens: 10,
          kept_tokens: 2,
          tokens_saved_pct: 80,
          mode: "neural-keep",
          latency_ms: 5,
        }),
      };
    });
    const mod = require("./neural-keep");
    const out = await mod.compressViaNeuralKeep("ctx", "q");
    assert.equal(n, 2);
    assert.ok(out);
    assert.equal(out.compressed_text, "kept");
  });

  it("returns null after exhausted 503 retries", async () => {
    let n = 0;
    mockFetch(async () => {
      n += 1;
      return {
        ok: false,
        status: 503,
        statusText: "Unavailable",
        headers: { get: () => "0" },
        json: async () => ({ detail: "busy" }),
      };
    });
    const mod = require("./neural-keep");
    const out = await mod.compressViaNeuralKeep("ctx", "q");
    assert.equal(out, null);
    assert.ok(n >= 6);
  });
});

describe("engine prefers neural-keep when SC_NEURAL_KEEP_URL is set", () => {
  const origEnv = { ...process.env };
  const origFetch = global.fetch;

  afterEach(() => {
    process.env = { ...origEnv };
    global.fetch = origFetch;
    delete require.cache[require.resolve("./engine")];
    delete require.cache[require.resolve("./neural-keep")];
  });

  it("compressAdaptive uses neural-keep remote when enabled", async () => {
    process.env.SC_NEURAL_KEEP_URL = "https://neural.example.test";
    process.env.SC_NEURAL_KEEP = "1";
    let fetched = false;
    mockFetch(async () => {
      fetched = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          compressed_text: "ERROR db timeout — kept",
          original_tokens: 40,
          kept_tokens: 8,
          tokens_saved_pct: 80,
          policy_name: "SuperCompress Neural Keep",
          mode: "neural-keep",
          latency_ms: 12,
        }),
      };
    });

    const engine = require("./engine");
    const result = await engine.compressAdaptive(
      "INCIDENT: warehouse W-ORBIT crashed\nnoise filler line\nanother noise line",
      "What warehouse crashed?"
    );
    assert.equal(fetched, true);
    assert.equal(result.mode, "neural-keep");
    assert.match(result.compressed_text, /ERROR db timeout/);
    assert.ok(
      result.kept_tokens != null && result.kept_tokens > 0,
      `neural-keep must return kept_tokens (got ${result.kept_tokens})`
    );
    assert.equal(
      result.kept_tokens,
      result.compressed_tokens,
      "kept_tokens and compressed_tokens must stay in sync"
    );
  });
});
