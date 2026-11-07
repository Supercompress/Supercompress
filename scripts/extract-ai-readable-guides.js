#!/usr/bin/env node
/**
 * Generate noindex Markdown alternates from current HTML guides.
 *
 * Source of truth is the live HTML on this tree (including R47/R49 body
 * links). Do not copy stale extract packs.
 *
 *   node scripts/extract-ai-readable-guides.js           # write web/<slug>.md
 *   node scripts/extract-ai-readable-guides.js --check   # fail if stale
 *   node scripts/extract-ai-readable-guides.js --hooks   # also ensure HTML
 *                                                        # alternate + entity JSON-LD
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");
const GUIDES_PATH = path.join(WEB, "assets/data/ai-readable-guides.json");
const ENTITY_PATH = path.join(WEB, "assets/data/entity.json");
const LOGO_SRC = path.join(WEB, "assets/img/favicon-chevron.svg");
const LOGO_DEST = path.join(WEB, "logo.svg");
const SITE = "https://www.supercompress.dev";
const ENTITY_SCRIPT_ID = "supercompress-entity";

const SKIP_MD_BASENAMES = new Set(["supercompress.md", "moltbook.md"]);

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadGuides() {
  const data = loadJson(GUIDES_PATH);
  if (!Array.isArray(data.guides) || data.guides.length === 0) {
    throw new Error("ai-readable-guides.json is missing guides[]");
  }
  for (const slug of data.guides) {
    if (!/^[a-z0-9-]+$/.test(slug)) {
      throw new Error(`invalid guide slug: ${slug}`);
    }
  }
  return data.guides;
}

function loadEntity() {
  const entity = loadJson(ENTITY_PATH);
  if (!entity.name || !entity.url || !entity.description || !Array.isArray(entity.sameAs)) {
    throw new Error("entity.json is missing name/url/description/sameAs");
  }
  return entity;
}

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  nbsp: " ",
  middot: "·",
  apos: "'",
};

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const SKIP_TAGS = new Set(["script", "style", "svg", "noscript", "iframe", "object", "template"]);
const SKIP_CLASS_EXACT = new Set(["seo-kicker", "seo-author", "seo-tags"]);
const INLINE_TAGS = new Set(["a", "strong", "b", "em", "i", "code", "br", "span", "small", "time"]);
const BLOCKED_HREF_SCHEME = /^(javascript|data|vbscript|file|blob):/i;

/**
 * Decode HTML entities in a single left-to-right pass so `&amp;lt;` becomes
 * `&lt;` rather than `<`. Do not chain replacements that re-scan `&amp;`.
 */
function decodeEntitiesOnce(input) {
  return String(input).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);/g, (entity, body) => {
    if (body.charAt(0) === "#") {
      const code =
        body.charAt(1) === "x" || body.charAt(1) === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return entity;
      try {
        return String.fromCodePoint(code);
      } catch {
        return entity;
      }
    }
    const mapped = NAMED_ENTITIES[body.toLowerCase()];
    return mapped === undefined ? entity : mapped;
  });
}

const decodeEntities = decodeEntitiesOnce;

function hostnameOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function hostIsOrSubdomainOf(url, rootHost) {
  const host = hostnameOf(url);
  return host === rootHost || host.endsWith(`.${rootHost}`);
}

function absUrl(href, slug) {
  if (!href) return "";
  const trimmed = String(href).trim();
  if (!trimmed || BLOCKED_HREF_SCHEME.test(trimmed)) return "";
  if (/^https?:/i.test(trimmed) || /^mailto:/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("#")) {
    return slug ? `${SITE}/${slug}${trimmed}` : trimmed;
  }
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (trimmed.startsWith("/")) return SITE + trimmed;
  return "";
}

function parseClassList(value) {
  return String(value || "")
    .split(/\s+/)
    .map((c) => c.trim())
    .filter(Boolean);
}

function parseAttrs(raw) {
  const attrs = {};
  const source = String(raw || "");
  const re = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(source))) {
    attrs[m[1].toLowerCase()] = decodeEntitiesOnce(m[3] || m[4] || m[5] || "");
  }
  return attrs;
}

function tokenizeHtml(html) {
  const tokens = [];
  const s = String(html);
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("<!--", i)) {
      const end = s.indexOf("-->", i + 4);
      i = end === -1 ? s.length : end + 3;
      continue;
    }
    if (s.charAt(i) !== "<") {
      const next = s.indexOf("<", i);
      const end = next === -1 ? s.length : next;
      tokens.push({ type: "text", value: s.slice(i, end) });
      i = end;
      continue;
    }
    const close = s.indexOf(">", i + 1);
    if (close === -1) {
      tokens.push({ type: "text", value: s.slice(i) });
      break;
    }
    let raw = s.slice(i + 1, close);
    const selfClosing = raw.endsWith("/");
    if (selfClosing) raw = raw.slice(0, -1);
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("!") || trimmed.startsWith("?")) {
      i = close + 1;
      continue;
    }
    const isClose = trimmed.charAt(0) === "/";
    const body = isClose ? trimmed.slice(1).trim() : trimmed;
    const nameMatch = body.match(/^([a-zA-Z][\w:-]*)/);
    const name = nameMatch ? nameMatch[1].toLowerCase() : "";
    const attrSource = nameMatch ? body.slice(nameMatch[0].length) : body;
    const kind = isClose ? "close" : selfClosing || VOID_TAGS.has(name) ? "void" : "open";
    tokens.push({ type: kind, name, attrs: kind === "close" ? {} : parseAttrs(attrSource) });
    i = close + 1;
  }
  return tokens;
}

function buildTree(tokens) {
  const root = { type: "element", name: "root", attrs: {}, children: [] };
  const stack = [root];
  for (const token of tokens) {
    const parent = stack[stack.length - 1];
    if (token.type === "text") {
      parent.children.push({ type: "text", value: token.value });
      continue;
    }
    if (token.type === "void") {
      parent.children.push({ type: "element", name: token.name, attrs: token.attrs, children: [] });
      continue;
    }
    if (token.type === "open") {
      const node = { type: "element", name: token.name, attrs: token.attrs, children: [] };
      parent.children.push(node);
      stack.push(node);
      continue;
    }
    if (token.type === "close") {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === token.name) {
          stack.length = i;
          break;
        }
      }
    }
  }
  return root;
}

function classList(node) {
  return parseClassList(node.attrs && node.attrs.class);
}

function shouldSkipNode(node) {
  if (node.type !== "element") return false;
  if (SKIP_TAGS.has(node.name)) return true;
  return classList(node).some((c) => SKIP_CLASS_EXACT.has(c));
}

function rawText(node) {
  if (!node) return "";
  if (node.type === "text") return node.value || "";
  return (node.children || []).map(rawText).join("");
}

function escapeTableCell(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

function stashFence(slots, body) {
  const id = slots.length;
  slots.push(body.replace(/\n$/, ""));
  return `\n\n%%SCMDCODE${id}%%\n\n`;
}

function restoreFences(markdown, slots) {
  let out = markdown;
  for (let i = 0; i < slots.length; i++) {
    out = out.split(`%%SCMDCODE${i}%%`).join("```\n" + slots[i] + "\n```");
  }
  return out;
}

function renderInline(nodes, ctx) {
  let out = "";
  for (const node of nodes || []) {
    if (node.type === "text") {
      out += decodeEntitiesOnce(node.value).replace(/\s+/g, " ");
      continue;
    }
    if (shouldSkipNode(node)) continue;
    const name = node.name;
    if (name === "br") {
      out += "\n";
      continue;
    }
    if (name === "a") {
      const label = renderInline(node.children, ctx).replace(/\s+/g, " ").trim();
      const url = absUrl(node.attrs.href, ctx.slug);
      if (!label) continue;
      out += url ? `[${label}](${url})` : label;
      continue;
    }
    if (name === "strong" || name === "b") {
      const text = renderInline(node.children, ctx).trim();
      out += text ? `**${text}**` : "";
      continue;
    }
    if (name === "em" || name === "i") {
      const text = renderInline(node.children, ctx).trim();
      out += text ? `*${text}*` : "";
      continue;
    }
    if (name === "code") {
      const text = decodeEntitiesOnce(rawText(node)).replace(/\n+/g, " ").trim();
      out += text ? "`" + text.replace(/`/g, "\\`") + "`" : "";
      continue;
    }
    out += renderInline(node.children, ctx);
  }
  return out;
}

function collectRows(node, rows) {
  if (node.type !== "element") return;
  if (node.name === "tr") {
    const cells = [];
    for (const child of node.children || []) {
      if (child.type === "element" && (child.name === "td" || child.name === "th")) {
        cells.push(child);
      }
    }
    if (cells.length) rows.push(cells);
    return;
  }
  for (const child of node.children || []) collectRows(child, rows);
}

function renderTable(node, ctx) {
  const rows = [];
  collectRows(node, rows);
  if (!rows.length) return "";
  const rendered = rows.map((row) =>
    row.map((cell) => escapeTableCell(renderInline(cell.children, ctx)))
  );
  const width = Math.max(...rendered.map((r) => r.length));
  const norm = rendered.map((r) => {
    const copy = r.slice();
    while (copy.length < width) copy.push("");
    return copy;
  });
  const lines = [
    `| ${norm[0].join(" | ")} |`,
    `| ${norm[0].map(() => "---").join(" | ")} |`,
    ...norm.slice(1).map((r) => `| ${r.join(" | ")} |`),
  ];
  return `\n${lines.join("\n")}\n`;
}

function renderList(node, ctx, ordered) {
  const items = (node.children || []).filter((c) => c.type === "element" && c.name === "li");
  if (!items.length) return "";
  const lines = items
    .map((item, i) => {
      const text = renderInline(item.children, ctx).replace(/\s+/g, " ").trim();
      if (!text) return "";
      return ordered ? `${i + 1}. ${text}` : `- ${text}`;
    })
    .filter(Boolean);
  return lines.length ? `\n${lines.join("\n")}\n` : "";
}

function isInlineish(node) {
  if (node.type === "text") return true;
  return node.type === "element" && INLINE_TAGS.has(node.name);
}

function childrenAreInline(node) {
  const kids = (node.children || []).filter((k) => !(k.type === "text" && !String(k.value || "").trim()));
  return kids.length > 0 && kids.every(isInlineish);
}

function renderNavLinks(node, ctx) {
  const links = [];
  function walk(n) {
    if (n.type === "element" && n.name === "a") {
      const label = renderInline(n.children, ctx).replace(/\s+/g, " ").trim();
      const url = absUrl(n.attrs.href, ctx.slug);
      if (label) links.push(url ? `- [${label}](${url})` : `- ${label}`);
      return;
    }
    for (const child of n.children || []) walk(child);
  }
  walk(node);
  return links.length ? `\n${links.join("\n")}\n` : "";
}

function renderBlocks(nodes, ctx) {
  let out = "";
  for (const node of nodes || []) {
    if (node.type === "text") {
      const text = decodeEntitiesOnce(node.value);
      if (text.trim()) out += text.trim() + "\n";
      continue;
    }
    if (shouldSkipNode(node)) continue;
    const name = node.name;
    if (name === "nav" || classList(node).includes("seo-cluster")) {
      out += renderNavLinks(node, ctx);
      continue;
    }
    if (name === "pre") {
      const body = decodeEntitiesOnce(rawText(node));
      out += stashFence(ctx.slots, body);
      continue;
    }
    if (/^h[1-6]$/.test(name)) {
      const level = Number(name.charAt(1));
      if (level === 1 && ctx.skipFirstH1 && !ctx.seenH1) {
        ctx.seenH1 = true;
        continue;
      }
      if (level === 1) ctx.seenH1 = true;
      const text = renderInline(node.children, ctx).replace(/\s+/g, " ").trim();
      if (text) out += `\n${"#".repeat(level)} ${text}\n`;
      continue;
    }
    if (name === "p" || name === "figcaption") {
      const text = renderInline(node.children, ctx).replace(/\s+/g, " ").trim();
      if (text) out += `\n${text}\n`;
      continue;
    }
    if (name === "blockquote") {
      const text = renderInline(node.children, ctx).trim();
      if (text) out += `\n${text.split(/\n/).map((line) => `> ${line}`).join("\n")}\n`;
      continue;
    }
    if (name === "ul") {
      out += renderList(node, ctx, false);
      continue;
    }
    if (name === "ol") {
      out += renderList(node, ctx, true);
      continue;
    }
    if (name === "table") {
      out += renderTable(node, ctx);
      continue;
    }
    if (name === "hr") {
      out += "\n---\n";
      continue;
    }
    if (name === "br") {
      out += "\n";
      continue;
    }
    if (childrenAreInline(node)) {
      const text = renderInline(node.children, ctx).replace(/\s+/g, " ").trim();
      if (text) out += `\n${text}\n`;
      continue;
    }
    out += renderBlocks(node.children, ctx);
  }
  return out;
}

function tidyMarkdown(markdown) {
  return String(markdown)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/^\s+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findArticleRoot(tree) {
  const stack = [tree];
  while (stack.length) {
    const node = stack.shift();
    if (node.type === "element" && node.name === "main") {
      const classes = classList(node);
      if (classes.includes("seo-page") || Object.prototype.hasOwnProperty.call(node.attrs, "data-article-content")) {
        return node;
      }
      if (node.attrs && Object.keys(node.attrs).some((k) => k === "data-article-content" || k.startsWith("data-article-content"))) {
        return node;
      }
    }
    if (node.children) {
      for (const child of node.children) stack.push(child);
    }
  }
  return null;
}

function htmlToMarkdown(html, opts = {}) {
  const tree = buildTree(tokenizeHtml(html));
  const root = findArticleRoot(tree);
  if (!root) {
    throw new Error("missing <main data-article-content>");
  }
  const ctx = {
    slug: opts.slug || "",
    skipFirstH1: Boolean(opts.skipFirstH1),
    seenH1: false,
    slots: [],
  };
  const body = renderBlocks(root.children, ctx);
  return tidyMarkdown(restoreFences(body, ctx.slots));
}

function pageTitle(html, slug) {
  const tree = buildTree(tokenizeHtml(html));
  const root = findArticleRoot(tree) || tree;
  const stack = [root];
  while (stack.length) {
    const node = stack.shift();
    if (node.type === "element" && node.name === "h1") {
      const text = renderInline(node.children, { slug: slug || "", slots: [] }).replace(/\s+/g, " ").trim();
      if (text) return text;
    }
    if (node.children) {
      for (const child of node.children) stack.push(child);
    }
  }
  return slug;
}

function convertInline(html, slug) {
  const tree = buildTree(tokenizeHtml(html));
  return renderInline(tree.children, { slug: slug || "", slots: [] }).replace(/\s+/g, " ").trim();
}

function tableToMarkdown(inner, slug) {
  const tree = buildTree(tokenizeHtml(`<table>${inner}</table>`));
  const table = (tree.children || []).find((n) => n.type === "element" && n.name === "table") || tree;
  return renderTable(table, { slug: slug || "", slots: [] }).trim();
}

function buildMarkdown(slug, html) {
  const title = pageTitle(html, slug);
  const body = htmlToMarkdown(html, { slug, skipFirstH1: true });
  const canonical = `${SITE}/${slug}`;
  const h1Count = (body.match(/^# /gm) || []).length;
  if (h1Count > 0) {
    throw new Error(`${slug}: duplicate H1 leaked into body after skipFirstH1`);
  }
  const lines = [
    `# ${title}`,
    "",
    `Canonical HTML: ${canonical}`,
    "",
    "This Markdown file is a noindex convenience extract of the HTML page. Cite the HTML URL.",
    "",
    body,
    "",
  ];
  return lines.join("\n");
}

function entityGraph(entity = loadEntity()) {
  const orgId = `${entity.url.replace(/\/$/, "")}/#organization`;
  const appId = `${entity.url.replace(/\/$/, "")}/#software`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": orgId,
        name: entity.name,
        url: entity.url,
        description: entity.description,
        logo: {
          "@type": "ImageObject",
          url: entity.logo,
        },
        sameAs: entity.sameAs.slice(),
      },
      {
        "@type": "SoftwareApplication",
        "@id": appId,
        name: entity.name,
        url: entity.url,
        description: entity.description,
        applicationCategory: entity.applicationCategory,
        operatingSystem: entity.operatingSystem,
        installUrl: entity.installUrl,
        sameAs: entity.sameAs.slice(),
        publisher: { "@id": orgId },
      },
    ],
  };
}

function entityScriptTag(entity = loadEntity()) {
  const json = JSON.stringify(entityGraph(entity), null, 2);
  return `<script type="application/ld+json" id="${ENTITY_SCRIPT_ID}">\n${json}\n</script>`;
}

function markdownHeaderBlock(slug) {
  return {
    source: `/${slug}.md`,
    headers: [
      { key: "Content-Type", value: "text/markdown; charset=utf-8" },
      { key: "X-Robots-Tag", value: "noindex, follow" },
      { key: "Access-Control-Allow-Origin", value: "*" },
      { key: "Cache-Control", value: "public, max-age=3600, must-revalidate" },
      { key: "Link", value: `<${SITE}/${slug}>; rel="canonical"` },
      { key: "Content-Location", value: `${SITE}/${slug}` },
    ],
  };
}

function extraHeaderBlocks() {
  return [
    {
      source: "/ai.txt",
      headers: [
        { key: "Content-Type", value: "text/plain; charset=utf-8" },
        { key: "X-Robots-Tag", value: "index, follow, max-snippet:-1" },
        { key: "Access-Control-Allow-Origin", value: "*" },
        { key: "Cache-Control", value: "public, max-age=3600, must-revalidate" },
      ],
    },
    {
      source: "/logo.svg",
      headers: [
        { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
      ],
    },
  ];
}

function ensureAlternateLink(html, slug) {
  const alt = `<link rel="alternate" type="text/markdown" href="${SITE}/${slug}.md" />`;
  if (html.includes(alt)) return html;
  const canonicalRe = new RegExp(
    `<link rel="canonical" href="${SITE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/${slug}"\\s*/?>`
  );
  const match = html.match(canonicalRe);
  if (!match) {
    throw new Error(`${slug}: missing canonical link to insert markdown alternate`);
  }
  const indent = html.slice(html.lastIndexOf("\n", html.indexOf(match[0])) + 1).match(/^\s*/)[0];
  return html.replace(match[0], `${match[0]}\n${indent}${alt}`);
}

function replaceIndexedBlock(html, open, close, replacement) {
  const start = html.indexOf(open);
  if (start === -1) return null;
  const end = html.indexOf(close, start + open.length);
  if (end === -1) return null;
  return html.slice(0, start) + replacement + html.slice(end + close.length);
}

function ensureEntityJsonLd(html, entity) {
  const tag = entityScriptTag(entity);
  const open = `<script type="application/ld+json" id="${ENTITY_SCRIPT_ID}">`;
  const replaced = replaceIndexedBlock(html, open, "</script>", tag);
  if (replaced !== null) return replaced;
  const closeHead = html.toLowerCase().lastIndexOf("</head>");
  if (closeHead === -1) {
    throw new Error("missing </head> for entity JSON-LD");
  }
  const originalClose = html.slice(closeHead, closeHead + 7);
  return `${html.slice(0, closeHead)}  ${tag}\n${originalClose}${html.slice(closeHead + 7)}`;
}

function applyHtmlHooks(html, slug, entity) {
  return ensureEntityJsonLd(ensureAlternateLink(html, slug), entity);
}

function writeLogo() {
  const src = fs.readFileSync(LOGO_SRC);
  fs.writeFileSync(LOGO_DEST, src);
}

function htmlPathForSlug(slug) {
  return path.join(WEB, `${slug}.html`);
}

function mdPathForSlug(slug) {
  return path.join(WEB, `${slug}.md`);
}

function generateGuide(slug) {
  const htmlFile = htmlPathForSlug(slug);
  if (!fs.existsSync(htmlFile)) {
    throw new Error(`missing HTML for ${slug}: ${path.relative(ROOT, htmlFile)}`);
  }
  const html = fs.readFileSync(htmlFile, "utf8");
  return buildMarkdown(slug, html);
}

function writeGuides(slugs = loadGuides()) {
  const written = [];
  for (const slug of slugs) {
    const md = generateGuide(slug);
    fs.writeFileSync(mdPathForSlug(slug), md);
    written.push({ slug, bytes: Buffer.byteLength(md) });
  }
  writeLogo();
  return written;
}

function writeHtmlHooks(slugs = loadGuides(), entity = loadEntity()) {
  const changed = [];
  for (const slug of slugs) {
    const file = htmlPathForSlug(slug);
    const before = fs.readFileSync(file, "utf8");
    const after = applyHtmlHooks(before, slug, entity);
    if (after !== before) {
      fs.writeFileSync(file, after);
      changed.push(slug);
    }
  }
  return changed;
}

function checkGeneratedMarkdown(slugs = loadGuides()) {
  const errors = [];
  for (const slug of slugs) {
    const expected = generateGuide(slug);
    const dest = mdPathForSlug(slug);
    if (!fs.existsSync(dest)) {
      errors.push(`missing ${path.relative(ROOT, dest)}; run node scripts/extract-ai-readable-guides.js`);
      continue;
    }
    const actual = fs.readFileSync(dest, "utf8");
    if (actual !== expected) {
      errors.push(`${slug}.md is stale vs current HTML; run node scripts/extract-ai-readable-guides.js`);
    }
    if (!expected.includes(`Canonical HTML: ${SITE}/${slug}`)) {
      errors.push(`${slug}.md missing canonical HTML URL`);
    }
    const h1Count = (expected.match(/^# /gm) || []).length;
    if (h1Count !== 1) {
      errors.push(`${slug}.md must have exactly one H1, found ${h1Count}`);
    }
    if (/<(script|style|div|table|p)\b/i.test(expected)) {
      errors.push(`${slug}.md still contains HTML tags`);
    }
    if (slug === "mcp-tool-output-compression" && !expected.includes('"context": "<the MCP tool result>"')) {
      errors.push(`${slug}.md lost encoded <pre> placeholders`);
    }
  }
  return errors;
}

function headerMapFromVercel(config) {
  const map = new Map();
  for (const rule of config.headers || []) {
    map.set(rule.source, rule);
  }
  return map;
}

function headerHas(rule, key, value) {
  const headers = (rule && rule.headers) || [];
  return headers.some((h) => h.key === key && h.value === value);
}

function checkVercelHeaders(slugs, config) {
  const errors = [];
  const map = headerMapFromVercel(config);
  for (const slug of slugs) {
    const expected = markdownHeaderBlock(slug);
    const actual = map.get(expected.source);
    if (!actual) {
      errors.push(`vercel.json missing headers for ${expected.source}`);
      continue;
    }
    for (const h of expected.headers) {
      if (!headerHas(actual, h.key, h.value)) {
        errors.push(`${expected.source} missing header ${h.key}: ${h.value}`);
      }
    }
  }
  for (const extra of extraHeaderBlocks()) {
    const actual = map.get(extra.source);
    if (!actual) {
      errors.push(`vercel.json missing headers for ${extra.source}`);
      continue;
    }
    for (const h of extra.headers) {
      if (!headerHas(actual, h.key, h.value)) {
        errors.push(`${extra.source} missing header ${h.key}: ${h.value}`);
      }
    }
  }
  return errors;
}

function parseJsonLdScripts(html) {
  const out = [];
  const hay = String(html);
  const marker = 'type="application/ld+json"';
  let from = 0;
  while (from < hay.length) {
    const typeIdx = hay.indexOf(marker, from);
    if (typeIdx === -1) break;
    const scriptStart = hay.lastIndexOf("<script", typeIdx);
    if (scriptStart === -1 || scriptStart < from) {
      from = typeIdx + marker.length;
      continue;
    }
    const tagEnd = hay.indexOf(">", typeIdx);
    if (tagEnd === -1) break;
    const close = hay.indexOf("</script>", tagEnd + 1);
    if (close === -1) break;
    try {
      out.push(JSON.parse(hay.slice(tagEnd + 1, close)));
    } catch {
      // ignore unparsable blocks; other guards cover HTML quality
    }
    from = close + 9;
  }
  return out;
}

function flattenJsonLd(nodes) {
  const out = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node["@graph"])) {
      out.push(...node["@graph"]);
    } else {
      out.push(node);
    }
  }
  return out;
}

function checkHtmlHooks(slugs, entity) {
  const errors = [];
  const expectedGraph = entityGraph(entity);
  const expectedOrg = expectedGraph["@graph"][0];
  const expectedApp = expectedGraph["@graph"][1];
  for (const slug of slugs) {
    const html = fs.readFileSync(htmlPathForSlug(slug), "utf8");
    const alt = `<link rel="alternate" type="text/markdown" href="${SITE}/${slug}.md" />`;
    if (!html.includes(alt)) {
      errors.push(`${slug}.html missing markdown alternate link`);
    }
    if (!html.includes(`id="${ENTITY_SCRIPT_ID}"`)) {
      errors.push(`${slug}.html missing canonical entity JSON-LD`);
      continue;
    }
    const nodes = flattenJsonLd(parseJsonLdScripts(html));
    const org = nodes.find((n) => n["@id"] === expectedOrg["@id"] && n["@type"] === "Organization");
    const app = nodes.find((n) => n["@id"] === expectedApp["@id"] && n["@type"] === "SoftwareApplication");
    if (!org) errors.push(`${slug}.html missing Organization @id ${expectedOrg["@id"]}`);
    if (!app) errors.push(`${slug}.html missing SoftwareApplication @id ${expectedApp["@id"]}`);
    if (org && org.description !== entity.description) {
      errors.push(`${slug}.html Organization description diverges from entity.json`);
    }
    if (app && app.description !== entity.description) {
      errors.push(`${slug}.html SoftwareApplication description diverges from entity.json`);
    }
    const sameAs = (org && org.sameAs) || [];
    if (JSON.stringify(sameAs) !== JSON.stringify(entity.sameAs)) {
      errors.push(`${slug}.html Organization sameAs diverges from entity.json`);
    }
    if (sameAs.some((u) => hostIsOrSubdomainOf(u, "medium.com"))) {
      errors.push(`${slug}.html sameAs includes unverified Medium profile`);
    }
  }
  return errors;
}

function checkLogo() {
  const errors = [];
  if (!fs.existsSync(LOGO_DEST)) {
    errors.push("web/logo.svg is missing");
    return errors;
  }
  const src = fs.readFileSync(LOGO_SRC);
  const dest = fs.readFileSync(LOGO_DEST);
  if (!src.equals(dest)) {
    errors.push("web/logo.svg must be a byte copy of web/assets/img/favicon-chevron.svg (existing chevron mark)");
  }
  if (!dest.toString("utf8").includes("<svg")) {
    errors.push("web/logo.svg is not SVG");
  }
  return errors;
}

function checkAiTxt(entity) {
  const errors = [];
  const file = path.join(WEB, "ai.txt");
  if (!fs.existsSync(file)) {
    errors.push("web/ai.txt is missing");
    return errors;
  }
  const text = fs.readFileSync(file, "utf8");
  for (const needle of [
    "name: SuperCompress",
    `url: ${entity.url}`,
    entity.description,
    "contact: support@supercompress.dev",
    "docs: https://docs.supercompress.dev/",
    "llms: https://www.supercompress.dev/llms.txt",
    "logo: https://www.supercompress.dev/logo.svg",
    ...entity.sameAs.map((u) => `sameAs: ${u}`),
  ]) {
    if (!text.includes(needle)) {
      errors.push(`web/ai.txt missing ${JSON.stringify(needle).slice(0, 80)}`);
    }
  }
  if (text.split(/\n/).some((line) => line.startsWith("sameAs:") && hostIsOrSubdomainOf(line.slice("sameAs:".length).trim(), "medium.com"))) {
    errors.push("web/ai.txt mentions unverified Medium profile");
  }
  if (/arjunkshah21@gmail\.com/i.test(text)) errors.push("web/ai.txt must use product contact, not a personal Gmail");
  return errors;
}

function checkLlmsAndRobots(slugs, entity) {
  const errors = [];
  const llms = fs.readFileSync(path.join(WEB, "llms.txt"), "utf8");
  const robots = fs.readFileSync(path.join(WEB, "robots.txt"), "utf8");
  const sitemap = fs.readFileSync(path.join(WEB, "sitemap.xml"), "utf8");
  const aiSearch = fs.readFileSync(path.join(WEB, "ai-search.json"), "utf8");

  if (!llms.includes(entity.description)) {
    errors.push("web/llms.txt identity paragraph must match entity.json description");
  }
  if (!llms.includes("https://www.supercompress.dev/ai.txt")) {
    errors.push("web/llms.txt must link /ai.txt");
  }
  for (const slug of slugs) {
    const mdUrl = `${SITE}/${slug}.md`;
    if (!llms.includes(mdUrl)) {
      errors.push(`web/llms.txt missing markdown alternate ${mdUrl}`);
    }
    if (sitemap.includes(`${slug}.md`)) {
      errors.push(`sitemap.xml must not list noindex ${slug}.md`);
    }
  }
  if (!robots.includes("https://www.supercompress.dev/ai.txt")) {
    errors.push("web/robots.txt must mention /ai.txt");
  }
  let aiSearchJson;
  try {
    aiSearchJson = JSON.parse(aiSearch);
  } catch (err) {
    errors.push(`web/ai-search.json is not valid JSON: ${err.message}`);
    return errors;
  }
  if (!aiSearchJson.entity || aiSearchJson.entity.description !== entity.description) {
    errors.push("web/ai-search.json entity.description must match entity.json");
  }
  if (JSON.stringify((aiSearchJson.entity && aiSearchJson.entity.sameAs) || []) !== JSON.stringify(entity.sameAs)) {
    errors.push("web/ai-search.json entity.sameAs must match entity.json");
  }
  return errors;
}

function checkHomepageUntouched(baselinePath) {
  const errors = [];
  const homepage = fs.readFileSync(path.join(WEB, "index.html"));
  if (baselinePath && fs.existsSync(baselinePath)) {
    const baseline = fs.readFileSync(baselinePath);
    if (!homepage.equals(baseline)) {
      errors.push("web/index.html changed; homepage must stay byte-identical");
    }
  }
  const text = homepage.toString("utf8");
  if (text.includes('type="text/markdown"')) {
    errors.push("web/index.html must not gain a markdown alternate");
  }
  if (text.includes(`id="${ENTITY_SCRIPT_ID}"`)) {
    errors.push("web/index.html must not receive the non-homepage entity JSON-LD block");
  }
  return errors;
}

function checkNoDoorwayPages() {
  const banned = [
    "best-context-compression-tools",
    "best-prompt-compression-tools",
    "best-mcp-tool-output-compression",
  ];
  const errors = [];
  for (const slug of banned) {
    for (const ext of [".html", ".md"]) {
      const file = path.join(WEB, slug + ext);
      if (fs.existsSync(file)) {
        errors.push(`do not add doorway page web/${slug}${ext}; use existing comparison pages`);
      }
    }
  }
  return errors;
}

function checkMdLinks(slugs) {
  const errors = [];
  const redirects = new Map();
  const vercel = loadJson(path.join(ROOT, "vercel.json"));
  for (const rule of vercel.redirects || []) {
    if (rule.has && rule.has.length) continue;
    const source = String(rule.source || "");
    if (!source || source === "/" || source.includes(":") || source.includes("*") || source.includes("(")) continue;
    redirects.set(source, String(rule.destination || ""));
  }

  function routeExists(pathname) {
    if (!pathname || pathname === "/") return true;
    if (redirects.has(pathname)) return true;
    const rel = pathname.replace(/^\//, "");
    const candidates = [
      path.join(WEB, rel),
      path.join(WEB, `${rel}.html`),
      path.join(WEB, rel, "index.html"),
      path.join(WEB, `${rel}.txt`),
      path.join(WEB, `${rel}.json`),
      path.join(WEB, `${rel}.md`),
      path.join(WEB, `${rel}.svg`),
    ];
    return candidates.some((p) => fs.existsSync(p));
  }

  const mdLink = /\]\((https:\/\/www\.supercompress\.dev[^)\s]+)\)/g;
  for (const slug of slugs) {
    const md = fs.readFileSync(mdPathForSlug(slug), "utf8");
    let m;
    while ((m = mdLink.exec(md))) {
      let url;
      try {
        url = new URL(m[1]);
      } catch {
        errors.push(`${slug}.md has invalid URL ${m[1]}`);
        continue;
      }
      if (url.pathname.endsWith(".md") && !slugs.includes(url.pathname.replace(/^\//, "").replace(/\.md$/, "")) && !SKIP_MD_BASENAMES.has(path.basename(url.pathname))) {
        // other markdown files on the site are allowed if they exist
      }
      if (!routeExists(url.pathname)) {
        errors.push(`${slug}.md links to missing path ${url.pathname}`);
      }
    }
  }
  return errors;
}

function checkAll(opts = {}) {
  const slugs = loadGuides();
  const entity = loadEntity();
  const vercel = loadJson(path.join(ROOT, "vercel.json"));
  const errors = [
    ...checkGeneratedMarkdown(slugs),
    ...checkVercelHeaders(slugs, vercel),
    ...checkHtmlHooks(slugs, entity),
    ...checkLogo(),
    ...checkAiTxt(entity),
    ...checkLlmsAndRobots(slugs, entity),
    ...checkHomepageUntouched(opts.homepageBaseline),
    ...checkNoDoorwayPages(),
    ...checkMdLinks(slugs),
  ];
  return { slugs, errors };
}

function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const hooks = argv.includes("--hooks");
  const slugs = loadGuides();
  if (!check) {
    const written = writeGuides(slugs);
    for (const item of written) {
      console.log(`wrote web/${item.slug}.md (${item.bytes} bytes)`);
    }
    console.log("wrote web/logo.svg from web/assets/img/favicon-chevron.svg");
    if (hooks) {
      const changed = writeHtmlHooks(slugs);
      console.log(changed.length ? `updated HTML hooks: ${changed.join(", ")}` : "HTML hooks already present");
    }
  }
  const result = checkAll({
    homepageBaseline: argv.includes("--homepage-baseline")
      ? argv[argv.indexOf("--homepage-baseline") + 1]
      : null,
  });
  if (result.errors.length) {
    for (const err of result.errors) console.error(`❌ ${err}`);
    process.exit(1);
  }
  console.log(`ok ai-readable guides (${result.slugs.length} slugs, entity, logo, headers)`);
}

module.exports = {
  ROOT,
  WEB,
  SITE,
  ENTITY_SCRIPT_ID,
  SKIP_MD_BASENAMES,
  loadGuides,
  loadEntity,
  decodeEntities,
  absUrl,
  convertInline,
  tableToMarkdown,
  htmlToMarkdown,
  buildMarkdown,
  entityGraph,
  entityScriptTag,
  markdownHeaderBlock,
  extraHeaderBlocks,
  applyHtmlHooks,
  generateGuide,
  writeGuides,
  writeHtmlHooks,
  writeLogo,
  checkAll,
  main,
};

if (require.main === module) {
  main();
}
