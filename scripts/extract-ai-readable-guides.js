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

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&middot;/gi, "·")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2f;/gi, "/")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function absUrl(href) {
  if (!href) return "";
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("javascript:")) return "";
  if (/^(https?:|mailto:|fragment:)/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("#")) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (trimmed.startsWith("/")) return SITE + trimmed;
  return trimmed;
}

function attr(attrs, name) {
  const m = String(attrs || "").match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!m) return "";
  return m[2] || m[3] || m[4] || "";
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ""));
}

function convertInline(html) {
  let s = String(html);
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs, text) => {
    const href = attr(attrs, "href");
    const label = convertInline(text).replace(/\s+\n/g, " ").replace(/\n\s+/g, " ").trim();
    const url = absUrl(href);
    if (!label) return "";
    return url ? `[${label}](${url})` : label;
  });
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, inner) => {
    const text = convertInline(inner).trim();
    return text ? `**${text}**` : "";
  });
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, inner) => {
    const text = convertInline(inner).trim();
    return text ? `*${text}*` : "";
  });
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => {
    const text = stripTags(inner).replace(/\n+/g, " ").trim();
    return text ? `\`${text}\`` : "";
  });
  s = s.replace(/<[^>]+>/g, "");
  return decodeEntities(s);
}

function tableToMarkdown(inner) {
  const rows = [];
  String(inner).replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => {
    const cells = [];
    String(row).replace(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi, (__, cell) => {
      cells.push(convertInline(cell).replace(/\s+/g, " ").trim().replace(/\|/g, "\\|"));
      return "";
    });
    if (cells.length) rows.push(cells);
    return "";
  });
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => {
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

function listToMarkdown(inner, ordered) {
  const items = [];
  String(inner).replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, item) => {
    items.push(convertInline(item).replace(/\s+/g, " ").trim());
    return "";
  });
  if (!items.length) return "";
  const lines = items
    .filter(Boolean)
    .map((item, i) => (ordered ? `${i + 1}. ${item}` : `- ${item}`));
  return `\n${lines.join("\n")}\n`;
}

function extractMain(html) {
  const m = String(html).match(/<main\b[^>]*data-article-content[^>]*>([\s\S]*?)<\/main>/i);
  if (!m) {
    throw new Error("missing <main data-article-content>");
  }
  return m[1];
}

function convertBlocks(html) {
  let s = String(html);
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<svg\b[\s\S]*?<\/svg>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<p class="seo-kicker"[^>]*>[\s\S]*?<\/p>/gi, "");
  s = s.replace(/<p class="seo-author"[^>]*>[\s\S]*?<\/p>/gi, "");
  s = s.replace(/<div class="seo-tags"[^>]*>[\s\S]*?<\/div>/gi, "");

  s = s.replace(/<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, code) => {
    const body = decodeEntities(code.replace(/<[^>]+>/g, "")).replace(/\n$/, "");
    return `\n\`\`\`\n${body}\n\`\`\`\n`;
  });
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => {
    const body = decodeEntities(code.replace(/<[^>]+>/g, "")).replace(/\n$/, "");
    return `\n\`\`\`\n${body}\n\`\`\`\n`;
  });

  s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, inner) => tableToMarkdown(inner));
  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => listToMarkdown(inner, true));
  s = s.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_, inner) => listToMarkdown(inner, false));

  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => {
    const text = convertInline(inner).replace(/\s+/g, " ").trim();
    return text ? `\n${"#".repeat(Number(level))} ${text}\n` : "";
  });
  s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, inner) => {
    const text = convertInline(inner).replace(/[ \t]+\n/g, "\n").trim();
    return text ? `\n${text}\n` : "";
  });
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
    const text = convertInline(inner).trim();
    if (!text) return "";
    return `\n${text.split(/\n/).map((line) => `> ${line}`).join("\n")}\n`;
  });
  s = s.replace(/<hr\s*\/?>/gi, "\n---\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");

  s = s.replace(/<\/?(div|section|article|nav|header|span|figure|main|aside)[^>]*>/gi, "\n");
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (match) => convertInline(match).trim());
  s = s.replace(/<(strong|b|em|i|code)\b[^>]*>[\s\S]*?<\/\1>/gi, (match) => convertInline(match).trim());
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function htmlToMarkdown(html) {
  return convertBlocks(extractMain(html));
}

function pageTitle(html, slug) {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const text = convertInline(h1[1]).replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  const title = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (title) {
    return stripTags(title[1]).split("|")[0].trim() || slug;
  }
  return slug;
}

function buildMarkdown(slug, html) {
  const title = pageTitle(html, slug);
  const body = htmlToMarkdown(html);
  const canonical = `${SITE}/${slug}`;
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

function ensureEntityJsonLd(html, entity) {
  const tag = entityScriptTag(entity);
  const re = new RegExp(
    `<script type="application/ld\\+json" id="${ENTITY_SCRIPT_ID}">[\\s\\S]*?</script>`
  );
  if (re.test(html)) return html.replace(re, tag);
  if (!/<\/head>/i.test(html)) {
    throw new Error("missing </head> for entity JSON-LD");
  }
  return html.replace(/<\/head>/i, `  ${tag}\n</head>`);
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
    if (!/^# /m.test(expected)) {
      errors.push(`${slug}.md missing H1`);
    }
    if (/<(script|style|div|table|p)\b/i.test(expected)) {
      errors.push(`${slug}.md still contains HTML tags`);
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
  const re = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      // ignore unparsable blocks; other guards cover HTML quality
    }
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
    if (sameAs.some((u) => /medium\.com/i.test(u))) {
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
  if (/medium\.com/i.test(text)) errors.push("web/ai.txt mentions unverified Medium profile");
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
