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

  it("returns null on HTTP error", async () => {
    global.fetch = async () => ({
      ok: false,
      status: 503,
      statusText: "Unavailable",
      json: async () => ({ detail: "model not loaded" }),
    });
    const mod = require("./neural-keep");
    const out = await mod.compressViaNeuralKeep("ctx", "q");
    assert.equal(out, null);
  });
});

describe("engine neural-keep integration", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
    delete require.cache[require.resolve("./engine")];
    delete require.cache[require.resolve("./neural-keep")];
  });

  it("compressAdaptive uses neural-keep when configured", async () => {
    process.env.SC_NEURAL_KEEP_URL = "https://neural.example.test";
    process.env.SC_NEURAL_KEEP = "1";

    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        compressed_text: "INCIDENT: warehouse W-ORBIT",
        original_tokens: 50,
        kept_tokens: 10,
        tokens_saved_pct: 80,
        policy_name: "SuperCompress Neural Keep",
        mode: "neural-keep",
        latency_ms: 5,
      }),
    });

    const engine = require("./engine");
    const result = await engine.compressAdaptive("INCIDENT: warehouse\nnoise\nnoise", "W-ORBIT?");
    assert.equal(result.mode, "neural-keep");
    assert.match(result.compressed_text, /W-ORBIT/);
    assert.equal(result.policy_name, "SuperCompress Neural Keep");
  });
});
