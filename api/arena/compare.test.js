/**
 * Arena compare API smoke — SuperCompress side must run.
 * Run: node api/arena/compare.test.js
 */
const assert = require("assert");
const handler = require("./compare");

function mockRes() {
  const out = { statusCode: 0, headers: {}, body: null };
  const res = {
    setHeader(k, v) {
      out.headers[k] = v;
    },
    end() {},
    status(code) {
      out.statusCode = code;
      return {
        json(payload) {
          out.body = payload;
        },
      };
    },
  };
  return Object.assign(res, { get out() { return out; } });
}

function mockReq(body, method = "POST") {
  return {
    method,
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
    body,
  };
}

(async () => {
  const ctx = [
    "INCIDENT: warehouse W-ORBIT shelf S-19 tipped",
    "Action: lock aisle 19, page safety lead Amira Okonkwo",
    ...Array.from({ length: 30 }, (_, i) => `rfid_ping bay=${i} ok`),
  ].join("\n");
  const query = "What happened in warehouse W-ORBIT?";

  const res = mockRes();
  await handler(mockReq({ context: ctx, query }), res);

  assert.equal(res.out.statusCode, 200, `expected 200 got ${res.out.statusCode} ${JSON.stringify(res.out.body)}`);
  const data = res.out.body;
  assert.equal(data.arena, "supercompress-context-compression-arena");
  assert.ok(data.supercompress);
  assert.ok(data.supercompress.tokens_in > 0);
  assert.ok(data.supercompress.compressed_preview.includes("W-ORBIT"));
  assert.ok(data.supercompress.answer_retained, "SC should retain answer on incident preset");
  assert.ok(data.winner);
  assert.ok(data.methodology.killer_metric === "cost_per_success_usd");

  // OPTIONS
  const resOpt = mockRes();
  await handler(mockReq({}, "OPTIONS"), resOpt);
  assert.equal(resOpt.out.statusCode, 204);

  // validation
  const resBad = mockRes();
  await handler(mockReq({ context: "" }), resBad);
  assert.equal(resBad.out.statusCode, 422);

  console.log("arena/compare.test.js: ok", {
    sc_removed: data.supercompress.removed_pct,
    hr: data.headroom.status || data.headroom.source || "ok",
    winner: data.winner.system,
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
