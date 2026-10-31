const assert = require("node:assert/strict");
const { test } = require("node:test");
const { computeCompressFingerprint } = require("./billing-ledger");

test("raw dump fingerprints agree for blank queries but differ from explicit tasks", () => {
  const fingerprint = query => computeCompressFingerprint({ context: "Raw research dump", query });
  assert.equal(fingerprint(undefined), fingerprint(""));
  assert.equal(fingerprint("   "), fingerprint(""));
  assert.notEqual(fingerprint(""), fingerprint("Summarize this context."));
});
