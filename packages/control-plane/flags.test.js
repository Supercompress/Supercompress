"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { flags, flagOn } = require("./flags");

describe("control-plane flags", () => {
  const prev = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
  });

  it("defaults all flags off", () => {
    delete process.env.SC_CP_LEDGER;
    delete process.env.SC_CP_TRACE;
    delete process.env.SC_CP_RESERVE;
    delete process.env.SC_CP_GATEWAY;
    delete process.env.SC_CP_ROUTE;
    delete process.env.SC_CP_ENTERPRISE;
    const f = flags();
    assert.equal(f.ledger, false);
    assert.equal(f.trace, false);
    assert.equal(f.reserve, false);
    assert.equal(f.gateway, false);
    assert.equal(f.route, false);
    assert.equal(f.enterprise, false);
  });

  it("flagOn accepts common truthy values", () => {
    process.env.SC_CP_GATEWAY = "true";
    assert.equal(flagOn("SC_CP_GATEWAY"), true);
    process.env.SC_CP_GATEWAY = "on";
    assert.equal(flagOn("SC_CP_GATEWAY"), true);
    process.env.SC_CP_GATEWAY = "0";
    assert.equal(flagOn("SC_CP_GATEWAY"), false);
  });
});
