"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { once } = require("node:events");
const { createServer } = require("./server");
const { resolveRoute } = require("./routes");
const { smoke } = require("../../scripts/fly-api-smoke");

async function serve(context, resolver) {
  const server = createServer(resolver);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("production smoke contract passes against the real adapter", async (context) => {
  await smoke(await serve(context));
});

test("compress aliases share the authenticated v1 handler", () => {
  const canonical = resolveRoute("/api/v1/compress");
  for (const pathname of ["/compress", "/api/compress", "/v1/compress"]) {
    assert.equal(resolveRoute(pathname).handler, canonical.handler);
  }
  assert.equal(resolveRoute("/me").handler, resolveRoute("/api/me").handler);
  assert.equal(resolveRoute("/retrieve").handler, resolveRoute("/api/retrieve").handler);
});

test("rewrite operations cannot be overridden by URL parameters", () => {
  assert.equal(resolveRoute("/api/oauth/token", new URLSearchParams("op=authorize")).query.op, "token");
  assert.equal(resolveRoute("/v1/ops/otel").query.export, "otel");
  assert.equal(resolveRoute("/.well-known/oauth-protected-resource/mcp").query.op, "metadata-pr");
  assert.equal(resolveRoute("/.well-known/oauth-authorization-server/api/mcp").query.op, "metadata-as");
  assert.equal(resolveRoute("/api/keys/key%20id").query.id, "key id");
  assert.ok(resolveRoute("/api/limitcheck"), "limitcheck counter must be served by Fly");
});

test("unknown routes are JSON 404, not marketing HTML", async (context) => {
  const response = await fetch(`${await serve(context)}/missing`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).detail, "Not found");
});

test("Fly health identifies its runtime without changing the Vercel fallback", async (context) => {
  const previous = process.env.FLY_APP_NAME;
  context.after(() => {
    if (previous === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = previous;
  });
  process.env.FLY_APP_NAME = "supercompress-api";
  const response = await fetch(`${await serve(context)}/health`);
  assert.equal((await response.json()).service, "supercompress-fly");
});

test("malformed route escapes return 400 without killing the server", async (context) => {
  const base = await serve(context);
  assert.equal((await fetch(`${base}/api/keys/%FF`)).status, 400);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("invalid JSON returns 400 before invoking a handler", async (context) => {
  const base = await serve(context, () => ({ handler: () => assert.fail("handler invoked") }));
  const response = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad" });
  assert.equal(response.status, 400);
});

test("oversized bodies return a readable 413 instead of resetting the connection", async (context) => {
  const base = await serve(context, () => ({ handler: () => assert.fail("handler invoked") }));
  const response = await fetch(base, { method: "POST", body: "x".repeat(210_000) });
  assert.equal(response.status, 413);
  assert.match((await response.json()).detail, /too large/);
});

test("MCP keeps its supported 1.5 MB limit on both aliases", async (context) => {
  const base = await serve(context);
  for (const pathname of ["/mcp", "/api/mcp"]) {
    const response = await fetch(`${base}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { padding: "x".repeat(250_000) } }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, 1);
    const oversized = await fetch(`${base}${pathname}`, { method: "POST", body: "x".repeat(1_500_001) });
    assert.equal(oversized.status, 413);
  }
});

test("form-encoded OAuth bodies are decoded", async (context) => {
  const base = await serve(context, () => ({ handler: (req, res) => res.status(200).json(req.body) }));
  const response = await fetch(base, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "code=a%2Bb&scope=read+write" });
  assert.deepEqual(await response.json(), { code: "a+b", scope: "read write" });
});

test("response JSON strings remain valid JSON", async (context) => {
  const base = await serve(context, () => ({ handler: (_req, res) => res.status(200).json("ready") }));
  assert.equal(await (await fetch(base)).json(), "ready");
});

test("browser preflight keeps handler CORS headers", async (context) => {
  const response = await fetch(`${await serve(context)}/compress`, { method: "OPTIONS" });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.match(response.headers.get("access-control-allow-headers"), /X-API-Key/);
});

test("Stripe webhook receives the untouched signed bytes", async (context) => {
  const raw = '{ "spacing":  true }\n';
  const base = await serve(context, () => ({ rawBody: true, handler: async (req, res) => {
    assert.equal(req.body, undefined);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.status(200).send(Buffer.concat(chunks));
  } }));
  const response = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
  assert.equal(await response.text(), raw);
});

test("route loading failures produce safe JSON 500 responses", async (context) => {
  context.mock.method(console, "error", () => {});
  const base = await serve(context, () => { throw new Error("secret server configuration"); });
  const response = await fetch(base);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { detail: "Internal server error", host: "fly" });
});
