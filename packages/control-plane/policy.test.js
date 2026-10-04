"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { evaluateAdmission, normalizePolicy } = require("./policy");

describe("policy admission", () => {
  it("allows default policy", () => {
    const r = evaluateAdmission({ version: 1, compress_default: true }, {});
    assert.equal(r.allow, true);
    assert.ok(r.reasons.includes("ok"));
  });

  it("denies model not on allowlist", () => {
    const r = evaluateAdmission(
      { allow_models: ["gpt-4o-mini"], compress_default: true },
      { model: "gpt-4o" }
    );
    assert.equal(r.allow, false);
    assert.ok(r.reasons.some((x) => x.startsWith("model_not_allowed")));
  });

  it("enforces max_usd_per_request", () => {
    const r = evaluateAdmission(
      { max_usd_per_request: 1, compress_default: true },
      { estimated_usd: 2 }
    );
    assert.equal(r.allow, false);
  });

  it("normalizes version", () => {
    assert.equal(normalizePolicy({}).version, 1);
  });
});
