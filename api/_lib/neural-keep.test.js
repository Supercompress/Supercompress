"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

describe("neural-keep client", () => {
  const origFetch = global.fetch;
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env.SC_NEURAL_KEEP_URL = "https://neural.example.test";
    process.env.SC_NEURAL_KEEP_SECRET = "sekret";
    delete process.env.SC_NEURAL_KEEP;
  });

  afterEach(() => {
    global.fetch = origFetch;
    process.env = { ...origEnv };
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
    global.fetch = async (url, opts) => {
      seenUrl = url;
      seenBody = JSON.parse(opts.body);
      seenAuth = opts.headers.Authorization;
      return {
        ok: true,
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
        }),
      };
    };

    const mod = require("./neural-keep");
    const out = await mod.compressViaNeuralKeep("long\ncontext", "why fail?");
    assert.ok(out);
    assert.equal(seenUrl, "https://neural.example.test/v1/compress");
    assert.equal(seenAuth, "Bearer sekret");
    assert.equal(seenBody.query, "why fail?");
    assert.equal(out.compressed_text, "kept line");
    assert.equal(out.tokens_saved_pct, 80);
    assert.equal(out.mode, "neural-keep");
  });

  it("retries once on 503 busy then succeeds", async () => {
    let n = 0;
    global.fetch = async () => {
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
    };
    const mod = require("./neural-keep");
    const out = await mod.compressViaNeuralKeep("ctx", "q");
    assert.equal(n, 2);
    assert.ok(out);
    assert.equal(out.compressed_text, "kept");
  });

  it("returns null after exhausted 503 retries", async () => {
    let n = 0;
    global.fetch = async () => {
      n += 1;
      return {
        ok: false,
        status: 503,
        statusText: "Unavailable",
        headers: { get: () => "0" },
        json: async () => ({ detail: "busy" }),
      };
    };
    const mod = require("./neural-keep");
    const out = await mod.compressViaNeuralKeep("ctx", "q");
    assert.equal(out, null);
    assert.ok(n >= 3);
  });
});

describe("engine prefers neural-keep when SC_NEURAL_KEEP_URL is set", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
    delete require.cache[require.resolve("./engine")];
    delete require.cache[require.resolve("./neural-keep")];
    if (global.fetch && global.fetch.mockRestore) global.fetch.mockRestore();
    delete global.fetch;
  });

  it("compressAdaptive uses neural-keep remote when enabled", async () => {
    process.env.SC_NEURAL_KEEP_URL = "https://neural.example.test";
    process.env.SC_NEURAL_KEEP = "1";
    let fetched = false;
    global.fetch = async () => {
      fetched = true;
      return {
        ok: true,
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
    };

    const engine = require("./engine");
    const result = await engine.compressAdaptive(
      "INCIDENT: warehouse W-ORBIT crashed\nnoise filler line\nanother noise line",
      "What warehouse crashed?"
    );
    assert.equal(fetched, true);
    assert.equal(result.mode, "neural-keep");
    assert.match(result.compressed_text, /ERROR db timeout/);
  });
});
