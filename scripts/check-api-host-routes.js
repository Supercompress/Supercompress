#!/usr/bin/env node
/**
 * Fail-closed guard: api.supercompress.dev redirects must NEVER intercept
 * compress / API aliases. Aug 2026 outage: a catch-all negative-lookahead
 * redirect ran before the /compress rewrite → 308 → clients turned POST into GET.
 *
 * Run: node scripts/check-api-host-routes.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const API_HOST = "api.supercompress.dev";
const ROOT = path.join(__dirname, "..");

const EXTRA_PROTECTED = [
  "/compress",
  "/v1/compress",
  "/api/compress",
  "/api/v1/compress",
  "/retrieve",
  "/api/retrieve",
  "/health",
  "/api/health",
  "/api/keys",
  "/api/account",
  "/api/usage",
  "/api/billing",
  "/api/billing/webhook",
  "/api/me",
  "/me",
  "/api/stats",
  "/api/firebase-config",
  "/api/affiliates",
  "/api/demo/compress",
];

function isApiHostRule(rule) {
  const has = rule.has || [];
  return has.some((h) => h && h.type === "host" && String(h.value) === API_HOST);
}

function escapeRegex(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function vercelSourceToRegExp(source) {
  const src = String(source || "");
  let out = "^";
  for (let i = 0; i < src.length; ) {
    if (src[i] === ":") {
      const m = src.slice(i).match(/^:([A-Za-z0-9_]+)(\*)?/);
      if (!m) {
        out += escapeRegex(src[i]);
        i += 1;
        continue;
      }
      out += m[2] ? ".*" : "[^/]+";
      i += m[0].length;
      continue;
    }
    out += escapeRegex(src[i]);
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}

function isCatchAllOrRegex(source) {
  const src = String(source || "");
  if (!src || src === "/") return false;
  if (/\(\?|\[\^|\|/.test(src)) return true; // lookahead / char-class / alternation
  if (src === "/*" || src === "/:path*" || src === "/:path(.*)" || src === "/(.*)") return true;
  if (/^\/:[A-Za-z0-9_]+\*$/.test(src)) return true; // /:splat*
  if (/^\/:[A-Za-z0-9_]+\(\.\*\)$/.test(src)) return true; // /:splat(.*) or /:rest(.*)
  // "/((?!api...).*)" style
  if (src.includes("(?!") || src.includes("(?:")) return true;
  return false;
}

function sourceMatchesPath(source, urlPath) {
  const src = String(source || "");
  const p = String(urlPath || "");
  if (src === p) return true;
  if (isCatchAllOrRegex(src)) {
    if (/^\/:[A-Za-z0-9_]+\*$/.test(src) || src === "/*") return true;
    try {
      return new RegExp(`^${src}$`).test(p);
    } catch {
      // Unparseable regex on api host → treat as matching everything (fail closed).
      return true;
    }
  }
  try {
    return vercelSourceToRegExp(src).test(p);
  } catch {
    return true;
  }
}

function listApiFilesystemPaths() {
  const apiDir = path.join(ROOT, "api");
  const out = [];
  function walk(dir, rel) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (name === "_lib" || name === "node_modules") continue;
      const full = path.join(dir, name);
      const nextRel = rel ? `${rel}/${name}` : name;
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        walk(full, nextRel);
        continue;
      }
      if (!name.endsWith(".js") || name.endsWith(".test.js")) continue;
      const route = "/" + nextRel.replace(/\.js$/, "").replace(/\[id\]/g, "x");
      out.push(route.startsWith("/api/") ? route : `/api${route === "/index" ? "" : route}`);
    }
  }
  walk(apiDir, "");
  return out;
}

function protectedPathsFromConfig(config) {
  const set = new Set(EXTRA_PROTECTED);
  for (const p of listApiFilesystemPaths()) set.add(p);
  for (const rw of config.rewrites || []) {
    const dest = String(rw.destination || "");
    const src = String(rw.source || "");
    if (dest.startsWith("/api/") || dest === "/api" || dest.includes("/compress")) {
      if (src.startsWith("/")) set.add(src);
    }
  }
  // Any /api/* or /v1/* probe variants
  for (const p of [...set]) {
    if (p.startsWith("/api/") || p.startsWith("/v1/")) set.add(p);
  }
  return [...set];
}

function checkApiHostRoutes(config) {
  const errors = [];
  const protectedPaths = protectedPathsFromConfig(config);
  const redirects = config.redirects || [];

  for (const rule of redirects) {
    if (!isApiHostRule(rule)) continue;
    const source = String(rule.source || "");
    if (isCatchAllOrRegex(source) && source !== "/") {
      errors.push(
        `Forbidden catch-all/regex redirect on ${API_HOST}: ${source} → ${rule.destination}. ` +
          `This outage class 308'd /compress (POST became GET). Use explicit marketing paths only.`
      );
      continue;
    }
    for (const p of protectedPaths) {
      if (sourceMatchesPath(source, p)) {
        errors.push(
          `api host redirect ${source} matches protected API path ${p} → ${rule.destination}. ` +
            `Redirects on ${API_HOST} must not intercept compress/API aliases.`
        );
      }
    }
  }
  return { ok: errors.length === 0, errors, protectedPaths };
}

function loadVercelJson() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
}

function main() {
  const result = checkApiHostRoutes(loadVercelJson());
  if (!result.ok) {
    console.error("FAIL api-host route guard:");
    for (const e of result.errors) console.error(" -", e);
    process.exit(1);
  }
  console.log(
    `ok api-host route guard (${result.protectedPaths.length} protected paths, no catch-all intercepts)`
  );
}

module.exports = {
  checkApiHostRoutes,
  sourceMatchesPath,
  isCatchAllOrRegex,
  vercelSourceToRegExp,
  API_HOST,
  EXTRA_PROTECTED,
};

if (require.main === module) main();
