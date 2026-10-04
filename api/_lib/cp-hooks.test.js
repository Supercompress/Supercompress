"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { maybeAttachControlPlane, getProcessLedger } = require("./cp-hooks");

describe("cp-hooks", () => {
  const prev = { ...process.env };

  beforeEach(() => {
    delete process.env.SC_CP_TRACE;
    delete process.env.SC_CP_LEDGER;
    getProcessLedger().clear();
  });

  afterEach(() => {
    process.env.SC_CP_TRACE = prev.SC_CP_TRACE;
    process.env.SC_CP_LEDGER = prev.SC_CP_LEDGER;
  });

  it("no-op when flags off", () => {
    const r = maybeAttachControlPlane({ original_tokens: 10, kept_tokens: 4 });
    assert.equal(r.compression_trace, undefined);
    assert.equal(r.sc_request_id, undefined);
  });

  it("attaches trace when SC_CP_TRACE=1", () => {
    process.env.SC_CP_TRACE = "1";
    const r = maybeAttachControlPlane({
      original_tokens: 100,
      kept_tokens: 40,
      engine: "neural_keep",
    });
    assert.equal(r.compression_trace.ratio, 0.4);
    assert.equal(r.compression_trace.strategy, "neural_keep");
  });

  it("writes ledger when SC_CP_LEDGER=1", () => {
    process.env.SC_CP_LEDGER = "1";
    process.env.SC_CP_TRACE = "1";
    const r = maybeAttachControlPlane(
      { original_tokens: 50, kept_tokens: 20 },
      { key_id: "k", idempotency_key: "hook-1" }
    );
    assert.ok(r.sc_request_id);
    const rec = getProcessLedger().get(r.sc_request_id);
    assert.equal(rec.status, "finalized");
    assert.equal(rec.compression.retained_tokens, 20);
  });
});
