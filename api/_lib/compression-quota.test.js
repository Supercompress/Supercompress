const assert = require("node:assert/strict");
const { test } = require("node:test");
const { attachCompressionQuota } = require("./compression-quota");
const { freeAllowance } = require("./stripe");

test("quota warnings use recorded usage and preserve compression warnings", () => {
  const owner = { customClaims: { sc_plan: "free" } };
  const response = attachCompressionQuota({ warnings: ["Safety passthrough"] }, owner, { tokens_in: 8886094 });
  assert.equal(response.tokens_used_this_period, 8886094);
  assert.equal(response.free_tokens_remaining, 0);
  assert.equal(response.free_tokens_per_month, freeAllowance(owner.customClaims));
  assert.match(response.warnings.join("\n"), /exhausted/);
  assert.ok(response.warnings.includes("Safety passthrough"));
  assert.equal(response.quota.free_tokens_remaining, 0);
  assert.equal(response.quota_warning, response.quota.warning);
});

test("unknown usage is not invented; positive remaining allowance is accurate", () => {
  assert.deepEqual(attachCompressionQuota({}, {}, undefined), {});
  for (const used of [NaN, Infinity, -1, "8886094"]) {
    assert.deepEqual(attachCompressionQuota({}, {}, { tokens_in: used }), {});
  }
  const response = attachCompressionQuota({}, {}, { tokens_in: 100 });
  assert.equal(response.free_tokens_remaining, freeAllowance({}) - 100);
  assert.equal(response.warnings, undefined);
});

test("unlimited accounts do not get a misleading exhausted warning", () => {
  for (const claims of [{ sc_comped: true }, { sc_metered: true }, { sc_plan: "pro" }]) {
    const response = attachCompressionQuota({}, { customClaims: claims }, { tokens_in: 8886094 });
    assert.equal(response.unlimited, true);
    assert.equal(response.warnings, undefined);
    assert.equal(response.quota.billing, "comped");
    assert.equal(response.quota_warning, undefined);
  }
});

test("quota refresh replaces stale nested state and warns near exhaustion without quoting prices", () => {
  const allowance = freeAllowance({});
  const response = attachCompressionQuota({ quota: { free_tokens_remaining: 0 }, quota_warning: "stale" }, {}, { tokens_in: allowance - 1 });
  assert.equal(response.quota.free_tokens_remaining, 1);
  assert.match(response.quota_warning, /nearly exhausted/);
  assert.doesNotMatch(response.quota_warning, /\$/);
  attachCompressionQuota(response, { customClaims: { sc_comped: true } }, { tokens_in: allowance });
  assert.equal(response.quota.free_tokens_remaining, 0);
  assert.equal(response.quota_warning, undefined);
  assert.equal(response.quota.warning, undefined);
});
