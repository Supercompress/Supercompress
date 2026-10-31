#!/usr/bin/env node
/**
 * Fail if crawlable marketing pages still point at vercel.json redirect
 * sources (retired slugs and aliases). Host-conditional redirects and the
 * homepage "/" are ignored so api/docs host splits do not false-positive.
 *
 * Scan: every web HTML page except the homepage and HTML files whose own
 * path is itself an unconditional redirect source, plus web/llms.txt and
 * web/llms-full.txt.
 *
 * Run: node scripts/check-redirect-hrefs.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");
const HOMEPAGE_REL = "web/index.html";

const SKIP_DIR_NAMES = new Set(["assets", "node_modules"]);

function loadVercelJson() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
}

function isUnconditionalRedirect(rule) {
  return !rule.has || rule.has.length === 0;
}

function isParameterizedSource(source) {
  return source.includes(":") || source.includes("(") || source.includes("*");
}

/**
 * Unconditional redirect sources (no host `has`), excluding "/" and
 * parameterized patterns.
 *
 * @param {object} config
 * @returns {Map<string, string>} pathname -> destination
 */
function unconditionalRedirectMap(config) {
  const map = new Map();
  for (const rule of config.redirects || []) {
    if (!isUnconditionalRedirect(rule)) continue;
    const source = String(rule.source || "");
    if (!source || source === "/") continue;
    if (isParameterizedSource(source)) continue;
    map.set(source, String(rule.destination || ""));
  }
  return map;
}

function walkFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, acc);
      continue;
    }
    if (entry.isFile()) acc.push(full);
  }
  return acc;
}

function htmlFileToPathname(absFile) {
  const rel = path.relative(WEB, absFile).replace(/\\/g, "/");
  if (rel === "index.html") return "/";
  if (rel.endsWith("/index.html")) return `/${rel.slice(0, -"/index.html".length)}`;
  if (rel.endsWith(".html")) return `/${rel.slice(0, -".html".length)}`;
  return null;
}

function extractHtmlHrefs(html) {
  const hrefs = [];
  const re = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  let m;
  while ((m = re.exec(html))) {
    hrefs.push(m[1] ?? m[2] ?? m[3]);
  }
  return hrefs;
}

function extractTxtHrefs(text) {
  const hrefs = [];
  const abs = text.matchAll(/https?:\/\/(?:www\.)?supercompress\.dev(\/[^\s)"'<>]*)/gi);
  for (const m of abs) hrefs.push(m[0]);
  const md = text.matchAll(/\[[^\]]*]\((\/[^)\s]+)\)/g);
  for (const m of md) hrefs.push(m[1]);
  return hrefs;
}

function pathnameFromHref(href) {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("mailto:") || trimmed.startsWith("javascript:")) {
    return null;
  }
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const url = new URL(trimmed);
      const host = url.hostname.toLowerCase();
      if (host !== "www.supercompress.dev" && host !== "supercompress.dev") return null;
      return url.pathname || "/";
    }
  } catch {
    return null;
  }
  if (trimmed.startsWith("/")) {
    const noHash = trimmed.split("#")[0];
    const noQuery = noHash.split("?")[0];
    return noQuery || "/";
  }
  return null;
}

function scanTargets() {
  const htmlFiles = walkFiles(WEB).filter((f) => f.endsWith(".html"));
  const txtFiles = [path.join(WEB, "llms.txt"), path.join(WEB, "llms-full.txt")].filter((f) =>
    fs.existsSync(f)
  );
  return { htmlFiles, txtFiles };
}

function findRedirectHrefs(config) {
  const redirects = unconditionalRedirectMap(config);
  const { htmlFiles, txtFiles } = scanTargets();
  const hits = [];

  for (const file of htmlFiles) {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    if (rel === HOMEPAGE_REL) continue;
    const ownPath = htmlFileToPathname(file);
    if (ownPath && redirects.has(ownPath)) continue;
    const hrefs = extractHtmlHrefs(fs.readFileSync(file, "utf8"));
    hrefs.forEach((href, i) => {
      const pathname = pathnameFromHref(href);
      if (!pathname || pathname === "/") return;
      if (!redirects.has(pathname)) return;
      hits.push({
        file: rel,
        href,
        pathname,
        destination: redirects.get(pathname),
        index: i,
      });
    });
  }

  for (const file of txtFiles) {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    const hrefs = extractTxtHrefs(fs.readFileSync(file, "utf8"));
    hrefs.forEach((href, i) => {
      const pathname = pathnameFromHref(href);
      if (!pathname || pathname === "/") return;
      if (!redirects.has(pathname)) return;
      hits.push({
        file: rel,
        href,
        pathname,
        destination: redirects.get(pathname),
        index: i,
      });
    });
  }

  return { redirects, hits };
}

function main() {
  const result = findRedirectHrefs(loadVercelJson());
  const count = result.hits.length;
  if (count === 0) {
    console.log(
      `ok redirect-href guard (0 hrefs to ${result.redirects.size} unconditional redirect sources)`
    );
    return;
  }
  console.error(`FAIL redirect-href guard: ${count} href(s) point at redirect sources`);
  for (const hit of result.hits) {
    console.error(` - ${hit.file} href=${hit.href} (${hit.pathname} → ${hit.destination})`);
  }
  process.exit(1);
}

module.exports = {
  unconditionalRedirectMap,
  pathnameFromHref,
  extractHtmlHrefs,
  extractTxtHrefs,
  findRedirectHrefs,
  htmlFileToPathname,
};

if (require.main === module) main();
