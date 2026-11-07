#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  SITE,
  ENTITY_SCRIPT_ID,
  absUrl,
  convertInline,
  tableToMarkdown,
  htmlToMarkdown,
  buildMarkdown,
  entityGraph,
  applyHtmlHooks,
  loadEntity,
  loadGuides,
} = require("./extract-ai-readable-guides");

assert.equal(absUrl("/faq"), `${SITE}/faq`);
assert.equal(absUrl("https://docs.supercompress.dev/coding-agents"), "https://docs.supercompress.dev/coding-agents");
assert.equal(absUrl("#table"), "#table");

assert.equal(
  convertInline('see <a href="/faq">FAQ</a> and <code>compress_context</code>'),
  `see [FAQ](${SITE}/faq) and \`compress_context\``
);
assert.equal(convertInline("<strong>In short:</strong> keep original lines"), "**In short:** keep original lines");

const tableMd = tableToMarkdown(
  "<thead><tr><th>Tool</th><th>What it does</th></tr></thead><tbody><tr><td><code>compress_context</code></td><td>Keeps lines</td></tr></tbody>"
);
assert.ok(tableMd.includes("| Tool | What it does |"));
assert.ok(tableMd.includes("| `compress_context` | Keeps lines |"));

const sample = `<html><head><title>Sample | SuperCompress</title>
<link rel="canonical" href="${SITE}/faq" />
</head><body>
<main class="seo-page" data-article-content>
<h1>SuperCompress FAQ</h1>
<p class="seo-lead">Hosted compression.</p>
<p>Cursor-specific steps are on how to <a href="/reduce-cursor-token-usage">reduce Cursor token usage</a>.</p>
<ul><li><strong>Keep it verbatim.</strong></li></ul>
</main>
</body></html>`;

const md = htmlToMarkdown(sample);
assert.ok(md.includes("# SuperCompress FAQ"));
assert.ok(md.includes(`[reduce Cursor token usage](${SITE}/reduce-cursor-token-usage)`));
assert.ok(md.includes("- **Keep it verbatim.**"));
assert.ok(!md.includes("<p"));

const page = buildMarkdown("faq", sample);
assert.ok(page.startsWith("# SuperCompress FAQ\n"));
assert.ok(page.includes(`Canonical HTML: ${SITE}/faq`));
assert.ok(page.includes("noindex convenience extract"));

const hooked = applyHtmlHooks(sample, "faq", loadEntity());
assert.ok(hooked.includes(`<link rel="alternate" type="text/markdown" href="${SITE}/faq.md" />`));
assert.ok(hooked.includes(`id="${ENTITY_SCRIPT_ID}"`));
const graph = entityGraph(loadEntity());
assert.equal(graph["@graph"][0]["@type"], "Organization");
assert.equal(graph["@graph"][1]["@type"], "SoftwareApplication");
assert.deepEqual(graph["@graph"][0].sameAs, loadEntity().sameAs);
assert.ok(!JSON.stringify(graph).toLowerCase().includes("medium.com"));
assert.equal(graph["@graph"][0].description, loadEntity().description);

const slugs = loadGuides();
assert.ok(slugs.includes("mcp-tool-output-compression"));
assert.ok(slugs.includes("context-compression-tools-compared"));
assert.ok(!slugs.includes("index"));

const mcp = fs.readFileSync(path.join(__dirname, "..", "web", "mcp-tool-output-compression.html"), "utf8");
const mcpMd = htmlToMarkdown(mcp);
assert.ok(mcpMd.includes("reduce Cursor token usage"), "extract must include R47 Cursor link from current HTML");
assert.ok(mcpMd.includes("reduce Claude Code token usage"), "extract must include R47 Claude Code link from current HTML");

console.log("extract-ai-readable-guides.test.js: ok");
