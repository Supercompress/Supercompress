/**
 * Soft-probe helpers — keep Vercel Observability error rate near zero.
 * Run: node api/_lib/http-soft-probe.test.js
 */
const assert = require("assert");
const { softProbe, hasAuthCredentials, json } = require("./http");
const { hasDrainCredentials } = require("./welcome");

function mockRes() {
  const out = { statusCode: 0, body: null, headers: {} };
  return {
    out,
    setHeader(k, v) { out.headers[k] = v; },
    status(c) { out.statusCode = c; return this; },
    json(b) { out.body = b; return this; },
    end() { return this; },
  };
}

assert.strictEqual(hasAuthCredentials({ headers: {} }), false);
assert.strictEqual(hasAuthCredentials({ headers: { authorization: "Bearer x" } }), true);
assert.strictEqual(hasAuthCredentials({ headers: { "x-api-key": "sc_live_x" } }), true);

assert.strictEqual(hasDrainCredentials({ headers: {}, query: {} }, {}), false);
assert.strictEqual(hasDrainCredentials({ headers: { "x-welcome-secret": "x" }, query: {} }, {}), true);
assert.strictEqual(hasDrainCredentials({ headers: { authorization: "Bearer x" }, query: {} }, {}), true);

const res = mockRes();
softProbe(res, "hi", { allow: "POST" });
assert.strictEqual(res.out.statusCode, 200);
assert.strictEqual(res.out.body.ok, false);
assert.strictEqual(res.out.body.probe, true);
assert.strictEqual(res.out.body.detail, "hi");
assert.strictEqual(res.out.body.allow, "POST");

const res2 = mockRes();
json(res2, 401, { detail: "nope" });
assert.strictEqual(res2.out.statusCode, 401);

console.log("http-soft-probe.test.js: ok");
