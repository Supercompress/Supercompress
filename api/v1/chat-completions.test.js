"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { statusFor } = require("./chat-completions");
const { modelObject } = require("./models");

test("gateway errors map to the right HTTP status", () => {
  assert.equal(statusFor({ message: "auth_required", class: "rejected" }), 401);
  assert.equal(statusFor({ class: "rejected", message: "rpm_exceeded" }), 429);
  assert.equal(statusFor({ class: "rejected", message: "rate_limited", status: 429 }), 429);
  assert.equal(statusFor({ class: "rejected", message: "money_store_unavailable" }), 503);
  assert.equal(statusFor({ class: "rejected", message: "credits_required", status: 402 }), 402);
  assert.equal(statusFor({ class: "invalid_request", message: "model_not_found: x", status: 400 }), 400);
  assert.equal(statusFor({ class: "conflict", message: "idempotency_key_in_progress", status: 409 }), 409);
  assert.equal(statusFor({ class: "rejected", message: "no_viable_model" }), 422);
  assert.equal(statusFor({ class: "error", message: "upstream_provider_unavailable:openai", status: 502 }), 502);
  assert.equal(statusFor({ class: "error", message: "client_closed_request", status: 499 }), 502);
});

test("model objects are OpenAI-shaped", () => {
  const m = modelObject({ id: "gpt-4o-mini", provider: "openai", max_context_tokens: 128000, capabilities: ["chat"] });
  assert.equal(m.object, "model");
  assert.equal(m.id, "gpt-4o-mini");
  assert.equal(m.owned_by, "openai");
  assert.equal(typeof m.created, "number");
});

test("the gateway surface serves only gateway routes", () => {
  const prev = process.env.SC_API_SURFACE;
  process.env.SC_API_SURFACE = "gateway";
  try {
    delete require.cache[require.resolve("../../services/api/routes")];
    const { resolveRoute } = require("../../services/api/routes");
    assert.ok(resolveRoute("/v1/chat/completions"));
    assert.ok(resolveRoute("/v1/models"));
    assert.ok(resolveRoute("/v1/models/gpt-4o"));
    assert.ok(resolveRoute("/health"));
    assert.equal(resolveRoute("/v1/compress"), null);
    assert.equal(resolveRoute("/mcp"), null);
    assert.equal(resolveRoute("/api/billing"), null);
  } finally {
    if (prev === undefined) delete process.env.SC_API_SURFACE;
    else process.env.SC_API_SURFACE = prev;
  }
});
