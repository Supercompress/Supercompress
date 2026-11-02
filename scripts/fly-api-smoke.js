"use strict";

const assert = require("node:assert/strict");

async function smoke(base = process.env.SUPERCOMPRESS_API_HOST || "https://api.supercompress.dev") {
  const checks = [
    ...(process.env.SC_API_SMOKE_SKIP_ROOT === "1" ? [] : [["/", 200, "GET"]]),
    ["/health", 200, "GET"],
    ["/api/health", 200, "GET"],
    ["/compress", 401, "POST"],
    ["/api/compress", 401, "POST"],
    ["/v1/compress", 401, "POST"],
    ["/api/v1/compress", 401, "POST"],
    ["/api/usage", 401, "GET"],
    ["/v1/chat/completions", 404, "POST"],
    ["/v1/models", 404, "GET"],
    ["/v1/ops/insights", 404, "GET"],
    ["/v1/ops/otel", 404, "GET"],
    ["/v1/ops/console", 404, "GET"],
    ["/api/billing/webhook", 200, "POST"],
    ["/.well-known/oauth-authorization-server", 200, "GET"],
  ];
  for (const [pathname, status, method] of checks) {
    const response = await fetch(new URL(pathname, base), {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(45_000),
      ...(method === "POST" ? {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context: "Fly deployment smoke test" }),
      } : {}),
    });
    assert.equal(response.status, status, `${pathname}: unexpected HTTP status`);
    assert.equal(response.headers.get("x-sc-host"), "fly", `${pathname}: not served by Fly adapter`);
    const body = await response.json();
    if (pathname.includes("health") || pathname === "/") assert.equal(body.ok, true);
    if (pathname === "/api/billing/webhook") assert.equal(body.probe, true);
    console.log(`PASS ${method} ${pathname} (${status}, Fly)`);
  }
}

if (require.main === module) {
  smoke().catch((error) => {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { smoke };
