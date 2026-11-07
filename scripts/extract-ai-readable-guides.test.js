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
  decodeEntities,
} = require("./extract-ai-readable-guides");

assert.equal(absUrl("/faq"), `${SITE}/faq`);
assert.equal(absUrl("https://docs.supercompress.dev/coding-agents"), "https://docs.supercompress.dev/coding-agents");
assert.equal(absUrl("#table"), "#table");
assert.equal(absUrl("#methods", "prompt-compression-guide"), `${SITE}/prompt-compression-guide#methods`);
assert.equal(absUrl("javascript:alert(1)"), "");
assert.equal(absUrl("data:text/html,hi"), "");
assert.equal(absUrl("vbscript:msgbox"), "");

assert.equal(decodeEntities("&amp;lt;the MCP tool result&amp;gt;"), "&lt;the MCP tool result&gt;");
assert.equal(decodeEntities("&lt;the MCP tool result&gt;"), "<the MCP tool result>");

assert.equal(
  convertInline('see <a href="/faq">FAQ</a> and <code>compress_context</code>'),
  `see [FAQ](${SITE}/faq) and \`compress_context\``
);
assert.equal(convertInline("<strong>In short:</strong> keep original lines"), "**In short:** keep original lines");
assert.equal(convertInline("<code>a&#96;b</code>"), "`` a`b ``");
assert.equal(convertInline("<code>a\\b</code>"), "`a\\b`");

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
assert.equal((page.match(/^# /gm) || []).length, 1, "exactly one H1");

const encodedCode = `<html><body>
<main class="seo-page" data-article-content>
<h1>Encoded</h1>
<pre><code>curl -d '{"context": "&lt;the MCP tool result&gt;", "query": "&lt;what the agent is trying to answer&gt;"}'</code></pre>
<p>Shows <code>&lt;kept&gt;</code> and &amp;amp;lt; stays one decode in text: &amp;lt;literal&amp;gt;.</p>
</main></body></html>`;
const encodedMd = htmlToMarkdown(encodedCode, { slug: "encoded", skipFirstH1: true });
assert.ok(
  encodedMd.includes(`{"context": "<the MCP tool result>", "query": "<what the agent is trying to answer>"}`),
  "encoded angle brackets in <pre><code> must survive as literal < >"
);
assert.ok(!encodedMd.includes(`{"context": "", "query": ""}`), "placeholders must not be stripped as tags");
assert.ok(encodedMd.includes("`&lt;kept&gt;`") || encodedMd.includes("`<kept>`"));
assert.ok(encodedMd.includes("&lt;literal&gt;"), "&amp;lt; in prose must decode once to &lt; not <");

const indentNav = `<html><body>
<main class="seo-page" data-article-content>
<h1>Nav</h1>
<nav class="seo-cluster">
    <a href="/faq">FAQ</a>
    <a href="/comparisons">Comparisons</a>
</nav>
<div class="seo-verdict"><strong>In short:</strong> keep original lines.</div>
</main></body></html>`;
const indentMd = htmlToMarkdown(indentNav, { slug: "nav", skipFirstH1: true });
assert.ok(indentMd.includes(`- [FAQ](${SITE}/faq)`));
assert.ok(indentMd.includes(`- [Comparisons](${SITE}/comparisons)`));
assert.ok(!/^ {4,}\[FAQ\]/m.test(indentMd), "nav links must not be indented as a markdown code block");
assert.ok(indentMd.includes("**In short:** keep original lines."));

const ctaHtml = `<html><body>
<main class="seo-page" data-article-content>
<h1>CTA</h1>
<p class="seo-cta-row">
      <a href="/dashboard?signup=1">Get API key</a>
      <a href="https://docs.supercompress.dev/coding-agents">Coding agents guide</a>
</p>
</main></body></html>`;
const ctaMd = htmlToMarkdown(ctaHtml, { slug: "cta", skipFirstH1: true });
assert.ok(ctaMd.includes("[Get API key]"));
assert.ok(ctaMd.includes("[Coding agents guide]"));
assert.ok(!/^ {4,}/m.test(ctaMd), "cta row links must not be indented as a markdown code block");

const toc = `<html><body>
<main class="seo-page" data-article-content>
<h1>Guide</h1>
<ol><li><a href="#methods">Methods</a></li></ol>
<section id="methods"><h2>Methods</h2></section>
</main></body></html>`;
const tocMd = htmlToMarkdown(toc, { slug: "guide", skipFirstH1: true });
assert.ok(tocMd.includes(`](${SITE}/guide#methods)`), "fragment links must target the HTML canonical URL");

const hooked = applyHtmlHooks(sample, "faq", loadEntity());
assert.ok(hooked.includes(`<link rel="alternate" type="text/markdown" href="${SITE}/faq.md" />`));
assert.ok(hooked.includes(`id="${ENTITY_SCRIPT_ID}"`));
const graph = entityGraph(loadEntity());
assert.equal(graph["@graph"][0]["@type"], "Organization");
assert.equal(graph["@graph"][1]["@type"], "SoftwareApplication");
assert.deepEqual(graph["@graph"][0].sameAs, loadEntity().sameAs);
for (const url of graph["@graph"][0].sameAs) {
  const host = new URL(url).hostname.toLowerCase();
  assert.notEqual(host, "medium.com");
  assert.equal(host.endsWith(".medium.com"), false);
}
assert.equal(graph["@graph"][0].description, loadEntity().description);

const slugs = loadGuides();
assert.ok(slugs.includes("mcp-tool-output-compression"));
assert.ok(slugs.includes("context-compression-tools-compared"));
assert.ok(!slugs.includes("index"));

const mcp = fs.readFileSync(path.join(__dirname, "..", "web", "mcp-tool-output-compression.html"), "utf8");
const mcpMd = htmlToMarkdown(mcp, { slug: "mcp-tool-output-compression", skipFirstH1: true });
assert.ok(mcpMd.includes("reduce Cursor token usage"), "extract must include R47 Cursor link from current HTML");
assert.ok(mcpMd.includes("reduce Claude Code token usage"), "extract must include R47 Claude Code link from current HTML");
assert.ok(
  mcpMd.includes(`"context": "<the MCP tool result>"`),
  "MCP curl example must keep encoded placeholders"
);
assert.ok(!mcpMd.includes(`"context": ""`), "MCP curl context placeholder must not be stripped");

console.log("extract-ai-readable-guides.test.js: ok");
