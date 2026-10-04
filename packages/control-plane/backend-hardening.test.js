"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createRateLimitStore, rateLimitKey } = require("./rate-limit");
const { createHealthTracker } = require("./health-tracker");
const { selectRoute } = require("./router");
const { heuristicCompress } = require("../../services/gateway/compress");

describe("rate-limit store", () => {
  it("enforces RPM then recovers after window", () => {
    let now = 1_000_000;
    const rl = createRateLimitStore({ windowMs: 1000, clock: () => now });
    const key = rateLimitKey({ key_id: "k1" });
    assert.equal(rl.consume(key, { rpm: 2 }, 10).allow, true);
    assert.equal(rl.consume(key, { rpm: 2 }, 10).allow, true);
    assert.equal(rl.consume(key, { rpm: 2 }, 10).allow, false);
    now += 1001;
    assert.equal(rl.consume(key, { rpm: 2 }, 10).allow, true);
  });

  it("enforces TPM including inbound tokens", () => {
    const rl = createRateLimitStore({ windowMs: 60_000 });
    const key = "rl:o:k:a";
    assert.equal(rl.consume(key, { tpm: 100 }, 80).allow, true);
    assert.equal(rl.consume(key, { tpm: 100 }, 30).allow, false);
  });
});

describe("health tracker circuit breaker", () => {
  it("trips down after failures and recovers after cooldown + successes", () => {
    let now = 0;
    const ht = createHealthTracker({
      failureThreshold: 2,
      successThreshold: 2,
      cooldownMs: 100,
      clock: () => now,
    });
    ht.recordFailure("m1");
    assert.equal(ht.get("m1").health, "degraded");
    ht.recordFailure("m1");
    assert.equal(ht.get("m1").health, "down");
    assert.equal(ht.healthMap().m1, "down");
    now += 101;
    assert.equal(ht.get("m1").health, "degraded");
    ht.recordSuccess("m1");
    ht.recordSuccess("m1");
    assert.equal(ht.get("m1").health, "up");
  });
});

describe("router strategies", () => {
  const catalog = [
    {
      id: "slow-cheap",
      provider: "a",
      max_context_tokens: 100_000,
      input_usd_per_mtok: 0.1,
      output_usd_per_mtok: 0.1,
      capabilities: ["chat"],
      latency_ms_p50: 2000,
      weight: 1,
      tier: 1,
    },
    {
      id: "fast-pricey",
      provider: "b",
      max_context_tokens: 100_000,
      input_usd_per_mtok: 2,
      output_usd_per_mtok: 2,
      capabilities: ["chat"],
      latency_ms_p50: 200,
      weight: 5,
      tier: 2,
    },
  ];

  it("latency_prefer picks fastest fit", () => {
    const d = selectRoute({
      retained_tokens: 1000,
      catalog,
      policy: { routing: { strategy: "latency_prefer", output_tokens_reserve: 100 } },
    });
    assert.equal(d.model, "fast-pricey");
    assert.equal(d.reason, "latency_prefer");
  });

  it("weighted prefers higher weight", () => {
    const d = selectRoute({
      retained_tokens: 1000,
      catalog,
      policy: { routing: { strategy: "weighted", output_tokens_reserve: 100 } },
    });
    assert.equal(d.model, "fast-pricey");
    assert.equal(d.reason, "weighted");
  });

  it("max_tier excludes flagship", () => {
    const d = selectRoute({
      retained_tokens: 1000,
      catalog,
      policy: {
        routing: { strategy: "cheapest_fit", max_tier: 1, output_tokens_reserve: 100 },
      },
    });
    assert.equal(d.model, "slow-cheap");
  });
});

describe("heuristic keep", () => {
  it("prefers ask-overlapping lines over naive head slice", () => {
    const ctx = [
      "noise pad line one",
      "noise pad line two",
      "Root cause: null deref in checkout",
      "more noise",
      "unrelated filler text here",
      "tail note",
    ].join("\n");
    const out = heuristicCompress(ctx, "why null deref checkout");
    assert.match(out.compressed_text, /Root cause/);
    assert.ok(out.kept_tokens < out.original_tokens);
    assert.equal(out.strategy, "compiler");
  });
});
