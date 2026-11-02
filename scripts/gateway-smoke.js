"use strict";

/**
 * Smoke test for the Control Plane gateway (supercompress-gateway).
 *   SC_GATEWAY_HOST=https://supercompress-gateway.fly.dev node scripts/gateway-smoke.js
 * Without a key it checks the surface: health up, auth required, non-gateway paths 404.
 * With SC_GATEWAY_SMOKE_KEY (a real sc_ key on an account with credit) it also lists models
 * and sends one tiny completion (costs a fraction of a cent) and checks the response shape.
 */

const assert = require("node:assert/strict");

async function call(base, pathname, { method = "GET", key, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(new URL(pathname, base), {
    method,
    headers,
    redirect: "manual",
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    /* non-JSON */
  }
  return { status: res.status, json, headers: res.headers };
}

async function smoke(base = process.env.SC_GATEWAY_HOST || "https://gateway.supercompress.dev") {
  const checks = [
    ["/health", "GET", 200],
    ["/v1/models", "GET", 401],
    ["/v1/chat/completions", "POST", 401],
    ["/v1/compress", "POST", 404],
    ["/mcp", "POST", 404],
    ["/api/billing", "GET", 404],
  ];
  for (const [p, method, want] of checks) {
    const r = await call(base, p, { method, body: method === "POST" ? { model: "x", messages: [] } : undefined });
    assert.equal(r.status, want, `${method} ${p}: got ${r.status}, want ${want}`);
    assert.equal(r.headers.get("x-sc-host"), "fly", `${p}: not served by Fly adapter`);
    console.log(`PASS ${method} ${p} (${want})`);
  }

  const key = process.env.SC_GATEWAY_SMOKE_KEY;
  if (!key) {
    console.log("SKIP live checks (set SC_GATEWAY_SMOKE_KEY to run them)");
    return;
  }
  const models = await call(base, "/v1/models", { key });
  assert.equal(models.status, 200, "GET /v1/models with key");
  assert.equal(models.json?.object, "list");
  assert.ok(models.json.data.length > 0, "no routable models: are provider keys set?");
  assert.ok(!models.json.data.some((m) => m.id === "stub-model"), "stub-model must never be listed");
  console.log(`PASS GET /v1/models (${models.json.data.length} models)`);

  const model = process.env.SC_GATEWAY_SMOKE_MODEL || models.json.data[0].id;
  const chat = await call(base, "/v1/chat/completions", {
    method: "POST",
    key,
    body: { model, max_tokens: 8, messages: [{ role: "user", content: "Reply with the word ok." }] },
  });
  assert.equal(chat.status, 200, `chat: ${chat.status} ${JSON.stringify(chat.json?.error || {})}`);
  assert.equal(chat.json.object, "chat.completion");
  assert.ok(chat.json.choices?.[0]?.message, "chat: no message");
  assert.ok(chat.json.choices[0].message.content !== "ok" || chat.json.usage.completion_tokens !== 3, "chat looks like the stub");
  console.log(`PASS POST /v1/chat/completions (${chat.json.model}, ${chat.json.usage.total_tokens} tokens)`);
}

if (require.main === module) {
  smoke().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { smoke };
