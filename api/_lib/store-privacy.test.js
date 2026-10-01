/**
 * Privacy / production-store gates from the deep security audit.
 * Run: node api/_lib/store-privacy.test.js
 */
const assert = require("assert");

const { gistAllowed } = require("./store");
const { agentUsageForMonth } = require("./coding-agent-usage");

// Snapshot env we touch so CI / local shells with VERCEL_ENV=production stay unchanged.
const snap = {
  VERCEL_ENV: process.env.VERCEL_ENV,
  NODE_ENV: process.env.NODE_ENV,
  SC_FORCE_PROD: process.env.SC_FORCE_PROD,
  SUPERCOMPRESS_ALLOW_GIST: process.env.SUPERCOMPRESS_ALLOW_GIST,
  SUPERCOMPRESS_DISABLE_GIST: process.env.SUPERCOMPRESS_DISABLE_GIST,
  SUPERCOMPRESS_STORE_GITHUB_TOKEN: process.env.SUPERCOMPRESS_STORE_GITHUB_TOKEN,
  SUPERCOMPRESS_STORE_GIST_ID: process.env.SUPERCOMPRESS_STORE_GIST_ID,
};

function restore() {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

try {
  process.env.VERCEL_ENV = "production";
  process.env.NODE_ENV = "production";
  delete process.env.SC_FORCE_PROD;
  delete process.env.SUPERCOMPRESS_ALLOW_GIST;
  delete process.env.SUPERCOMPRESS_DISABLE_GIST;
  process.env.SUPERCOMPRESS_STORE_GITHUB_TOKEN = "ghp_test";
  process.env.SUPERCOMPRESS_STORE_GIST_ID = "abc";
  assert.strictEqual(gistAllowed(), false, "prod must disable gist by default");

  process.env.SUPERCOMPRESS_ALLOW_GIST = "1";
  assert.strictEqual(gistAllowed(), true, "break-glass ALLOW_GIST=1 in prod");

  process.env.SUPERCOMPRESS_DISABLE_GIST = "1";
  assert.strictEqual(gistAllowed(), false, "DISABLE_GIST always wins");
} finally {
  restore();
}

{
  const out = agentUsageForMonth(
    {
      cursor: {
        requests: 1,
        tokens_in: 10,
        tokens_saved: 5,
        last_query: "secret prompt with password abc123",
        last_seen: "2026-09-01T00:00:00.000Z",
      },
    },
    "2026-09"
  );
  assert.ok(out.cursor);
  assert.ok(!("last_query" in out.cursor));
}

console.log("store-privacy.test.js: ok");
