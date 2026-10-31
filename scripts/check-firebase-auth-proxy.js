#!/usr/bin/env node
/**
 * Guard: www must proxy Firebase auth handler + allow auth iframes in CSP.
 * Without this, Google sign-in flakes when browsers block third-party cookies.
 */
const fs = require("fs");
const path = require("path");

const vercelPath = path.join(__dirname, "..", "vercel.json");
const raw = fs.readFileSync(vercelPath, "utf8");
const vercel = JSON.parse(raw);

const rewrites = vercel.rewrites || [];
const authRewrite = rewrites.find(
  (r) =>
    String(r.source || "") === "/__/auth/:path*" &&
    String(r.destination || "").includes("supercompress.firebaseapp.com/__/auth/")
);
if (!authRewrite) {
  console.error("FAIL: missing vercel rewrite /__/auth/:path* → supercompress.firebaseapp.com");
  process.exit(1);
}

const softIdx = rewrites.findIndex((r) => String(r.source || "") === "/api/:path*");
const authIdx = rewrites.findIndex((r) => String(r.source || "") === "/__/auth/:path*");
if (softIdx !== -1 && authIdx > softIdx) {
  console.error("FAIL: /__/auth rewrite must appear before /api/:path* soft-probe");
  process.exit(1);
}

const headers = vercel.headers || [];
let csp = "";
for (const block of headers) {
  for (const h of block.headers || []) {
    if (String(h.key || "").toLowerCase() === "content-security-policy") {
      csp = String(h.value || "");
    }
  }
}
if (!csp.includes("frame-src")) {
  console.error("FAIL: CSP missing frame-src");
  process.exit(1);
}
if (!/frame-src[^;]*'self'/.test(csp) || !/frame-src[^;]*\*\.firebaseapp\.com/.test(csp)) {
  console.error("FAIL: CSP frame-src must allow 'self' and https://*.firebaseapp.com for Google auth");
  process.exit(1);
}

console.log("ok firebase-auth-proxy guard");
