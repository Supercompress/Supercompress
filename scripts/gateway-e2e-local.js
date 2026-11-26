"use strict";
/**
 * Local end-to-end check of the gateway: the real API server on the gateway surface, with
 * mock OpenAI and Anthropic upstreams, so it needs no provider keys or Firebase.
 * Asserts what actually reaches each provider. Run: node scripts/gateway-e2e-local.js
 */
const http = require("node:http");
const path = require("node:path");
const assert = require("node:assert/strict");
const ROOT = path.resolve(__dirname, "..");


const seen = [];
function upstream(kind) {
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      seen.push({ kind, url: req.url, auth: req.headers.authorization || req.headers["x-api-key"], body });
      if (kind === "openai") {
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          for (const t of ["Hel", "lo"]) res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: t } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 2 } })}\n\n`);
          res.end("data: [DONE]\n\n");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "x", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 2, total_tokens: 52 } }));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "msg", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 50, output_tokens: 2 } }));
      }
    });
  });
}
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));

(async () => {
  const oa = await listen(upstream("openai"));
  const an = await listen(upstream("anthropic"));
  Object.assign(process.env, {
    NODE_ENV: "development", SC_API_SURFACE: "gateway", SC_CP_GATEWAY: "1", SC_CP_LEDGER: "1", SC_CP_TRACE: "1",
    SC_CP_ROUTE: "1", SUPERCOMPRESS_USE_FIRESTORE: "0", SC_NEURAL_KEEP: "0",
    OPENAI_API_KEY: "sk-test-openai", OPENAI_BASE_URL: `http://127.0.0.1:${oa}/v1`,
    ANTHROPIC_API_KEY: "sk-test-anthropic", ANTHROPIC_BASE_URL: `http://127.0.0.1:${an}`,
  });
  // Stub key auth: every sc_ key belongs to one test account.
  const ks = require.resolve(path.join(ROOT, "api/_lib/firebase-key-store"));
  require.cache[ks] = { id: ks, filename: ks, loaded: true, exports: { authenticateKey: async () => ({ ownerUid: "u1", keyId: "k1", owner: { uid: "u1", customClaims: {} } }) } };
  const { createServer } = require(path.join(ROOT, "services/api/server"));
  const srv = createServer();
  const port = await listen(srv);
  const base = `http://127.0.0.1:${port}`;
  const post = async (body, extra = {}) => {
    const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sc_live_test", ...extra }, body: JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  };
  const results = [];
  const check = async (name, fn) => { try { await fn(); results.push(["PASS", name]); } catch (e) { results.push(["FAIL", name, e.message]); } };

  await check("surface: health 200, compress 404, chat needs auth", async () => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/v1/compress`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${base}/v1/chat/completions`, { method: "POST", body: "{}" })).status, 401);
  });
  await check("models list contains current models", async () => {
    const r = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer sc_live_test" } });
    const ids = (await r.json()).data.map((m) => m.id);
    for (const id of ["auto", "gpt-6-luna", "gpt-6.1-sol", "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1"]) assert.ok(ids.includes(id), id);
  });
  await check("gpt-6-luna: max_completion_tokens, 16K default, key forwarded", async () => {
    seen.length = 0;
    const r = await post({ model: "gpt-6-luna", messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 200, r.text);
    const u = seen.at(-1);
    assert.equal(u.auth, "Bearer sk-test-openai");
    assert.equal(u.body.max_completion_tokens, 16384);
    assert.equal(u.body.max_tokens, undefined);
    assert.equal(JSON.parse(r.text).choices[0].message.content, "ok");
  });
  await check("claude-sonnet-5-5: no temperature, forced tool -> auto", async () => {
    seen.length = 0;
    const r = await post({ model: "claude-sonnet-5-5", temperature: 0.2, top_p: 0.9, messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object", properties: {} } } }], tool_choice: { type: "function", function: { name: "f" } } });
    assert.equal(r.status, 200, r.text);
    const u = seen.at(-1);
    assert.equal(u.kind, "anthropic");
    assert.equal(u.body.temperature, undefined);
    assert.equal(u.body.top_p, undefined);
    assert.deepEqual(u.body.tool_choice, { type: "auto" });
    assert.equal(u.body.max_tokens, 4096);
  });
  await check("claude-haiku-5-5: forced tool kept", async () => {
    seen.length = 0;
    const r = await post({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object", properties: {} } } }], tool_choice: "required" });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(seen.at(-1).body.tool_choice, { type: "any" });
  });
  await check("streaming returns SSE chunks and [DONE]", async () => {
    const r = await post({ model: "gpt-6-luna", stream: true, messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 200, r.text);
    assert.match(r.text, /"content":"Hel"/);
    assert.match(r.text, /data: \[DONE\]/);
  });
  await check("bulky tool output in array content is compressed before the provider", async () => {
    seen.length = 0;
    const mods = ["auth", "billing", "router", "ledger", "compress", "catalog", "policy", "wire"];
    // A real failure prints a stack and a verdict, not one line. (A lone line in a 300-line log is
    // below the API's collapse guard, which returns the input unchanged rather than one line.)
    const lines = Array.from({ length: 300 }, (_, i) =>
      `[${String(i).padStart(4, "0")}] compiling packages/${mods[i % 8]}/src/file${i}.ts (${(i * 37) % 900}ms) cache=${i % 3 ? "hit" : "miss"} warnings=0`);
    lines.splice(211, 0,
      "ERROR src/billing/settle.ts:88 TypeError: Cannot read properties of undefined (reading 'usd')",
      "    at settleInvoice (src/billing/settle.ts:88:21)",
      "    at processBatch (src/billing/batch.ts:41:9)",
      "    at runJob (src/jobs/runner.ts:117:5)",
      "build failed: 1 error in packages/billing");
    const bulk = lines.join("\n");
    const r = await post({ model: "gpt-6-luna", messages: [
      { role: "user", content: [{ type: "text", text: bulk }] },
      { role: "assistant", content: "noted" },
      { role: "user", content: "which module failed?" },
    ] });
    assert.equal(r.status, 200, r.text);
    const sent = seen.at(-1).body.messages[0].content;
    const sentText = Array.isArray(sent) ? sent.map((p) => p.text).join("") : sent;
    assert.ok(sentText.length < bulk.length, `sent ${sentText.length} vs ${bulk.length}`);
    assert.equal(seen.at(-1).body.messages[2].content, "which module failed?");
    assert.match(sentText, /settle\.ts:88/, "the error line survives");
    console.log(`   compressed ${bulk.length} -> ${sentText.length} chars`);
  });
  await check("auto: quick task -> small model, hard task -> frontier model", async () => {
    const { DEFAULT_CATALOG } = require(path.join(ROOT, "packages/control-plane/catalog"));
    const tierOf = (id) => DEFAULT_CATALOG.find((m) => m.id === id || m.upstream_model === id)?.tier;
    seen.length = 0;
    const easy = await post({ model: "auto", messages: [{ role: "user", content: "Write the commit message" }] });
    assert.equal(easy.status, 200, easy.text);
    assert.equal(tierOf(seen.at(-1).body.model), 1, `easy went to ${seen.at(-1).body.model}`);
    const hard = await post({ model: "auto", messages: [{ role: "user", content: "Find why auth only fails on CI" }] });
    assert.equal(hard.status, 200, hard.text);
    assert.equal(tierOf(seen.at(-1).body.model), 3, `hard went to ${seen.at(-1).body.model}`);
    console.log(`   easy -> ${JSON.parse(easy.text).model}, hard -> ${JSON.parse(hard.text).model}`);
  });
  await check("unknown model is a 400", async () => {
    const r = await post({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
    assert.ok([400, 422].includes(r.status), `${r.status} ${r.text}`);
  });
  for (const r of results) console.log(r.join("  "));
  process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
