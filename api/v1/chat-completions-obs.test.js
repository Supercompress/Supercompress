"use strict";

/**
 * HTTP edge: every response carries x-sc-request-id (the ledger row id), errors carry stable
 * codes, and the request log line has no prompt, completion, customer key or provider key.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const CUSTOMER_KEY = "sc_live_CUSTOMERSECRET0123456789";
const PROVIDER_KEY = "sk-live-PROVIDERSECRET-abcdef";
const PROMPT = "PROMPT_CANARY_edge";
const ANSWER = "RESPONSE_CANARY_edge";

Object.assign(process.env, {
  SC_CP_GATEWAY: "1",
  SC_CP_LEDGER: "1",
  SC_CP_TRACE: "1",
  OPENAI_API_KEY: PROVIDER_KEY,
});
delete process.env.SC_CP_DATABASE_URL;
delete process.env.DATABASE_URL;
delete process.env.SC_CP_DURABLE_DIR;

// Key auth without Firebase: one valid key.
const keyStorePath = path.resolve(__dirname, "../_lib/firebase-key-store.js");
require.cache[keyStorePath] = {
  id: keyStorePath,
  filename: keyStorePath,
  loaded: true,
  exports: {
    authenticateKey: async (token) => (token === CUSTOMER_KEY ? { ownerUid: "org_edge", keyId: "key_edge" } : null),
  },
};

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        model: body.model,
        choices: [{ message: { content: ANSWER }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      };
    },
  };
};

const handler = require("./chat-completions");
const { getProcessGateway } = require("../../services/gateway/http");

function call(body, { key = CUSTOMER_KEY } = {}) {
  const headers = {};
  let status = 0;
  let payload;
  const res = {
    statusCode: 0,
    writableEnded: false,
    setHeader: (k, v) => (headers[k.toLowerCase()] = v),
    getHeader: (k) => headers[k.toLowerCase()],
    on() {},
    status(s) {
      status = s;
      return this;
    },
    json(b) {
      payload = b;
      this.writableEnded = true;
    },
    end() {
      this.writableEnded = true;
    },
  };
  const req = {
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${key}`, "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 200)}` },
    body,
    socket: { remoteAddress: "127.0.0.1" },
  };
  return handler(req, res).then(() => ({ status, headers, payload }));
}

test("edge: request id header, stable error codes, and logs without content or keys", async () => {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map(String).join(" "));
  let ok, notFound, unauth;
  try {
    ok = await call({ model: "gpt-6-luna", messages: [{ role: "user", content: PROMPT }] });
    notFound = await call({ model: "no-such-model", messages: [{ role: "user", content: PROMPT }] });
    unauth = await call({ model: "gpt-6-luna", messages: [{ role: "user", content: PROMPT }] }, { key: "sc_live_wrong" });
  } finally {
    Object.assign(console, orig);
  }

  assert.equal(ok.status, 200);
  const id = ok.headers["x-sc-request-id"];
  assert.match(id, /^req_[0-9a-f]{24}$/);
  assert.equal(ok.payload.sc_request_id, id, "the body and the header quote the same id");
  assert.match(ok.headers["access-control-expose-headers"], /x-sc-request-id/);
  const rec = getProcessGateway().ledger.get(id);
  assert.ok(rec, "the header id is the ledger row id");
  assert.equal(rec.meta.obs.request_id, id);
  assert.equal(rec.meta.obs.provider.input_tokens, 12);

  assert.equal(notFound.status, 400);
  assert.equal(notFound.payload.error.code, "model_not_found");
  assert.equal(notFound.payload.sc_request_id, notFound.headers["x-sc-request-id"]);
  assert.equal(getProcessGateway().ledger.get(notFound.headers["x-sc-request-id"]).meta.obs.error.code, "model_not_found");

  assert.equal(unauth.status, 401);
  assert.match(unauth.headers["x-sc-request-id"], /^req_/, "even pre-gateway rejects carry an id");

  const logs = lines.join("\n");
  assert.match(logs, /"evt":"cp_chat"/);
  assert.match(logs, new RegExp(id));
  for (const canary of ["PROMPT_CANARY", "RESPONSE_CANARY", "CUSTOMERSECRET", "PROVIDERSECRET"]) {
    assert.equal(logs.includes(canary), false, `log leaks ${canary}`);
  }
});
