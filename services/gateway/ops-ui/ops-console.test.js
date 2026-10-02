"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const opsConsole = require("../../../api/v1/ops-console");

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = JSON.stringify(body);
      return this;
    },
    end(b) {
      this.body = b;
      return this;
    },
  };
  return res;
}

describe("ops-console HTTP", () => {
  const prev = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
  });

  it("404 when SC_CP_OPS off", async () => {
    delete process.env.SC_CP_OPS;
    const res = mockRes();
    await opsConsole({ method: "GET", url: "/api/v1/ops-console" }, res);
    assert.equal(res.statusCode, 404);
  });

  it("serves HTML when SC_CP_OPS on", async () => {
    process.env.SC_CP_OPS = "1";
    const res = mockRes();
    await opsConsole({ method: "GET", url: "/api/v1/ops-console" }, res);
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["Content-Type"]), /text\/html/);
    assert.match(String(res.body), /Super/);
    assert.match(String(res.body), /ops-console\?asset=css/);
  });
});
