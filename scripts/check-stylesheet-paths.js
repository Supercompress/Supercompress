#!/usr/bin/env node
/**
 * Guard against route-relative stylesheet URLs in static pages.
 *
 * Run: node scripts/check-stylesheet-paths.js
 */
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");

/**
 * Recursively retrieves all HTML file paths in a directory.
 *
 * @param {string} dir - Directory path to traverse.
 * @returns {string[]} Array of absolute file paths to HTML files.
 */
function htmlFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".html") ? [entryPath] : [];
  });
}

/**
 * Extracts stylesheet href attributes from HTML content.
 *
 * @param {string} html - HTML string to parse for stylesheet link tags.
 * @returns {string[]} Array of stylesheet href attribute values.
 */
function stylesheetHrefs(html) {
  return [...html.matchAll(/<link\b[^>]*>/gi)].flatMap(([tag]) => {
    const attribute = (name) => {
      const match = tag.match(
        new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\x60]+))`, "i")
      );
      return match?.slice(1).find((value) => value !== undefined);
    };
    const rel = attribute("rel");
    const href = attribute("href");
    return rel?.toLowerCase().split(/\s+/).includes("stylesheet") && href ? [href] : [];
  });
}

module.exports = { stylesheetHrefs };

/**
 * Validates that all stylesheet paths in static HTML pages are root-relative or external,
 * and verifies that the Python article normalizer produces conforming stylesheet paths.
 *
 * @returns {void}
 */
function main() {
  const invalidPaths = htmlFiles(WEB).flatMap((file) =>
    stylesheetHrefs(fs.readFileSync(file, "utf8"))
      .filter((href) => !href.startsWith("/") && !/^https?:\/\//i.test(href))
      .map((href) => `${path.relative(ROOT, file)}: ${href}`)
  );

  if (invalidPaths.length) {
    throw new Error(
      `Stylesheet URLs must be root-relative or external:\n${invalidPaths.join("\n")}`
    );
  }

  const normalizerCheck = String.raw`
import importlib.util
from pathlib import Path

root = Path.cwd()
spec = importlib.util.spec_from_file_location(
    "normalize_article_pages", root / "scripts" / "normalize_article_pages.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
html = '<head><link rel="stylesheet" href="assets/css/supercompress.css?v=105" /></head>'
result = module.ensure_css_links(html)
assert 'href="/assets/css/supercompress.css?v=105"' in result
assert 'href="assets/css/supercompress.css' not in result
`;
  const pythonBin = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  execFileSync(pythonBin, ["-c", normalizerCheck], {
    cwd: ROOT,
    stdio: "inherit",
  });

  console.log(
    `stylesheet path check: ${htmlFiles(WEB).length} HTML files and article normalizer passed`
  );
}

if (require.main === module) main();
