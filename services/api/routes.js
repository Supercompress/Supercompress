/**
 * Path → Vercel-style handler map + rewrite aliases (mirrors vercel.json API rewrites).
 * Marketing HTML routes are NOT served here — website stays on Vercel.
 */

"use strict";

const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

function load(rel) {
  return require(path.join(ROOT, rel));
}

/** @typedef {{ handler: Function, query?: Record<string, string>, rawBody?: boolean, maxBodyBytes?: number }} Route */

/**
 * Exact / prefix routes after rewrite normalization.
 * @type {Array<{ match: (pathname: string) => Route | null }>}
 */
function buildMatchers() {
  const compress = load("api/v1/compress.js");
  const chatCompletions = load("api/v1/chat-completions.js");
  const ops = load("api/v1/ops.js");
  const opsConsole = load("api/v1/ops-console.js");
  const retrieve = load("api/retrieve.js");
  const billingWebhook = load("api/billing-webhook.js");
  const account = load("api/account.js");
  const oauth = load("api/oauth.js");
  const mcp = load("api/mcp.js");
  const health = load("api/health.js");
  const keys = load("api/keys.js");
  const keyById = load("api/keys/[id].js");
  const billing = load("api/billing.js");
  const me = load("api/me.js");
  const stats = load("api/stats.js");
  const affiliates = load("api/affiliates.js");
  const founderUsage = load("api/founder-usage.js");
  const softProbe = load("api/soft-probe.js");
  const firebaseConfig = load("api/firebase-config.js");
  const demoCompress = load("api/demo/compress.js");
  const arenaCompare = load("api/arena/compare.js");
  const weeklyUnsub = load("api/weekly/unsubscribe.js");

  /** @type {Map<string, Route>} */
  const exact = new Map([
    ["/api/v1/compress", { handler: compress }],
    ["/compress", { handler: compress }],
    ["/api/compress", { handler: compress }],
    ["/v1/compress", { handler: compress }],

    ["/api/v1/chat-completions", { handler: chatCompletions }],
    ["/v1/chat/completions", { handler: chatCompletions }],
    ["/api/v1/chat/completions", { handler: chatCompletions }],

    ["/api/v1/ops", { handler: ops }],
    ["/v1/ops/insights", { handler: ops }],
    ["/api/v1/ops/insights", { handler: ops }],
    ["/v1/ops/otel", { handler: ops, query: { export: "otel" } }],
    ["/api/v1/ops/otel", { handler: ops, query: { export: "otel" } }],

    ["/api/v1/ops-console", { handler: opsConsole }],
    ["/v1/ops/console", { handler: opsConsole }],
    ["/api/v1/ops/console", { handler: opsConsole }],

    ["/api/retrieve", { handler: retrieve }],
    ["/retrieve", { handler: retrieve }],

    ["/api/billing-webhook", { handler: billingWebhook, rawBody: true }],
    ["/api/billing/webhook", { handler: billingWebhook, rawBody: true }],

    ["/api/mcp", { handler: mcp, maxBodyBytes: 1_500_000 }],
    ["/mcp", { handler: mcp, maxBodyBytes: 1_500_000 }],

    ["/api/oauth", { handler: oauth }],
    ["/api/oauth/authorize", { handler: oauth, query: { op: "authorize" } }],
    ["/api/oauth/token", { handler: oauth, query: { op: "token" } }],
    ["/api/oauth/register", { handler: oauth, query: { op: "register" } }],
    ["/api/oauth/revoke", { handler: oauth, query: { op: "revoke" } }],
    ["/api/oauth/approve", { handler: oauth, query: { op: "approve" } }],
    ["/.well-known/oauth-authorization-server", { handler: oauth, query: { op: "metadata-as" } }],
    ["/.well-known/oauth-protected-resource", { handler: oauth, query: { op: "metadata-pr" } }],
    ["/.well-known/oauth-protected-resource/api/mcp", { handler: oauth, query: { op: "metadata-pr" } }],

    ["/api/health", { handler: health }],
    ["/health", { handler: health }],
    ["/api/aiscore", { handler: health, query: { op: "aiscore" } }],

    ["/api/keys", { handler: keys }],
    ["/api/billing", { handler: billing }],
    ["/api/me", { handler: me }],
    ["/me", { handler: me }],
    ["/api/stats", { handler: stats }],
    ["/api/affiliates", { handler: affiliates }],
    ["/api/founder-usage", { handler: founderUsage }],
    ["/api/soft-probe", { handler: softProbe }],
    ["/api/firebase-config", { handler: firebaseConfig }],
    ["/api/demo/compress", { handler: demoCompress }],
    ["/api/arena/compare", { handler: arenaCompare }],
    ["/api/weekly/unsubscribe", { handler: weeklyUnsub }],

    // account ops (aliases)
    ["/api/account", { handler: account }],
    ["/api/auth-status", { handler: account, query: { op: "auth-status" } }],
    ["/api/connect-device", { handler: account, query: { op: "connect-device" } }],
    ["/api/usage", { handler: account, query: { op: "usage" } }],
    ["/api/welcome", { handler: account, query: { op: "welcome" } }],
    ["/api/welcome/pending", { handler: account, query: { op: "welcome-pending" } }],
    ["/api/welcome/mark", { handler: account, query: { op: "welcome-mark" } }],
    ["/api/welcome/drain", { handler: account, query: { op: "welcome-drain" } }],
  ]);

  return { exact, keyById, account };
}

let cached = null;

function getMatchers() {
  if (!cached) cached = buildMatchers();
  return cached;
}

/**
 * @param {string} pathname
 * @param {URLSearchParams} searchParams
 * @returns {Route | null}
 */
function resolveRoute(pathname, searchParams = new URLSearchParams()) {
  const clean = pathname.replace(/\/+$/, "") || "/";
  const { exact, keyById, account } = getMatchers();

  if (clean.startsWith("/.well-known/oauth-protected-resource/") ||
      clean.startsWith("/.well-known/oauth-authorization-server/")) {
    const metadata = clean.startsWith("/.well-known/oauth-protected-resource/")
      ? "/.well-known/oauth-protected-resource" : "/.well-known/oauth-authorization-server";
    return resolveRoute(metadata, searchParams);
  }

  // /api/keys/:id
  const keyMatch = clean.match(/^\/api\/keys\/([^/]+)$/);
  if (keyMatch) {
    return {
      handler: keyById,
      query: { id: decodeURIComponent(keyMatch[1]) },
    };
  }

  const hit = exact.get(clean);
  if (!hit) {
    if (clean === "/" || clean === "") {
      return {
        handler: async (_req, res) => {
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              ok: true,
              service: "sc-api",
              host: "fly",
              docs: "https://www.supercompress.dev/docs",
            })
          );
        },
      };
    }
    return null;
  }

  // URL query first; rewrite defaults (e.g. op=authorize) win.
  const query = {};
  for (const [k, v] of searchParams.entries()) query[k] = v;
  if (hit.query) Object.assign(query, hit.query);

  return { handler: hit.handler, query, rawBody: !!hit.rawBody, maxBodyBytes: hit.maxBodyBytes };
}

module.exports = { resolveRoute, ROOT };
