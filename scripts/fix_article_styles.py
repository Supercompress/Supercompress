#!/usr/bin/env python3
"""Convert off-style blog articles to seo-page + article-page.css layout."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"

SEO_CLUSTER = """
<nav class="seo-cluster" aria-label="SuperCompress topic cluster">
  <a href="/reduce-llm-costs">Reduce LLM costs</a>
  <a href="/token-compression">Token compression</a>
  <a href="/prompt-compression">Prompt compression</a>
  <a href="/context-compression">Smart context compression</a>
  <a href="https://docs.supercompress.dev/coding-agents">Coding agents</a>
  <a href="/supercompress-vs-headroom">vs Headroom</a>
  <a href="/blog">Blog</a>
</nav>
"""

NEW_CSS_LINKS = """<link rel="stylesheet" href="assets/css/supercompress.css?v=105" />
  <link rel="stylesheet" href="/assets/css/landing-chrome.css?v=7" />
  <link rel="stylesheet" href="/assets/css/seo-cluster.css?v=1" />
  <link rel="stylesheet" href="/assets/css/article-page.css?v=1" />"""


def strip_inline_style(html: str) -> str:
    return re.sub(r"\n?\s*<style>.*?</style>\s*", "\n", html, count=1, flags=re.S)


def replace_css_links(html: str) -> str:
    html = re.sub(
        r'\s*<link rel="stylesheet" href="assets/css/content-shell\.css\?v=\d+" />\s*',
        "\n",
        html,
    )
    pat = re.compile(
        r'<link rel="stylesheet" href="assets/css/supercompress\.css\?v=\d+" />\s*'
        r'(?:<link rel="stylesheet" href="/assets/css/landing-chrome\.css\?v=\d+" />\s*)?',
        re.M,
    )
    if pat.search(html):
        html = pat.sub(NEW_CSS_LINKS + "\n", html, count=1)
    elif "article-page.css" not in html:
        html = html.replace(
            'href="/assets/css/landing-chrome.css?v=7" />',
            'href="/assets/css/landing-chrome.css?v=7" />\n'
            '  <link rel="stylesheet" href="/assets/css/seo-cluster.css?v=1" />\n'
            '  <link rel="stylesheet" href="/assets/css/article-page.css?v=1" />',
            1,
        )
    while html.count("article-page.css") > 1:
        html = html.replace(
            '\n  <link rel="stylesheet" href="/assets/css/article-page.css?v=1" />', "", 1
        )
    while html.count("seo-cluster.css") > 1:
        html = html.replace(
            '\n  <link rel="stylesheet" href="/assets/css/seo-cluster.css?v=1" />', "", 1
        )
    return html


def remove_sc_topbar(html: str) -> str:
    return re.sub(r'<header class="sc-topbar">.*?</header>\s*', "", html, count=1, flags=re.S)


def remove_nav_bar(html: str) -> str:
    return re.sub(r'<nav class="nav-bar">.*?</nav>\s*', "", html, count=1, flags=re.S)


def split_lead(body: str):
    lead_m = re.match(r"(<p>.*?</p>)\s*(.*)", body, flags=re.S)
    if not lead_m:
        return "", body
    first_p, rest = lead_m.group(1), lead_m.group(2).strip()
    plain = re.sub(r"<[^>]+>", "", first_p)
    if len(plain) <= 420:
        return first_p.replace("<p>", '<p class="seo-lead">', 1), rest
    return "", body


def convert_shell_article(path: Path) -> None:
    html = path.read_text()
    if 'class="seo-page"' in html and "article-page.css" in html:
        print(f"skip (already converted): {path.name}")
        return
    html = strip_inline_style(html)
    html = replace_css_links(html)
    html = re.sub(r'<body class="sc-shell-page">', "<body>", html)
    html = remove_sc_topbar(html)
    m = re.search(
        r'<main class="sc-content article-page">\s*'
        r'<section class="sc-panel article-hero">\s*'
        r'<span class="sc-kicker">(.*?)</span>\s*'
        r"<h1>(.*?)</h1>\s*"
        r'<p class="article-meta">(.*?)</p>\s*'
        r"</section>\s*"
        r'<article class="article-body">(.*?)</article>\s*'
        r"</main>",
        html,
        flags=re.S,
    )
    if not m:
        raise SystemExit(f"Failed to parse shell article: {path}")
    kicker, title, meta, body = m.group(1), m.group(2), m.group(3), m.group(4).strip()
    lead_html, prose = split_lead(body)
    new_main = f"""<main class="seo-page">
    <p class="seo-kicker">{kicker}</p>
    <h1>{title}</h1>
{("    " + lead_html) if lead_html else ""}
    <p class="seo-author">{meta}</p>
{SEO_CLUSTER}
    <div class="article-prose">
{prose}
    </div>
  </main>"""
    html = html[: m.start()] + new_main + html[m.end() :]
    if "site-chrome.js" not in html:
        html = html.replace(
            "</body>", '  <script src="/assets/js/site-chrome.js?v=7"></script>\n</body>'
        )
    path.write_text(html)
    print(f"OK shell: {path.name}")


def convert_post_article(path: Path) -> None:
    html = path.read_text()
    if 'class="seo-page"' in html and "article-page.css" in html and "post-header" not in html:
        print(f"skip (already converted): {path.name}")
        return
    html = strip_inline_style(html)
    html = replace_css_links(html)
    html = remove_nav_bar(html)
    header_m = re.search(
        r'<header class="post-header">(.*?)</header>\s*'
        r'<main class="post-content">(.*?)</main>',
        html,
        flags=re.S,
    )
    if not header_m:
        raise SystemExit(f"Failed to parse post article: {path}")
    header_inner = header_m.group(1)
    body = header_m.group(2).strip()
    title_m = re.search(r"<h1>(.*?)</h1>", header_inner, flags=re.S)
    meta_m = re.search(r'<p class="meta">(.*?)</p>', header_inner, flags=re.S)
    tags = re.findall(r'<span class="sc-tag(?:\s+sc-tag--(\w+))?">(.*?)</span>', header_inner)
    title = title_m.group(1).strip() if title_m else "Untitled"
    meta = meta_m.group(1).strip() if meta_m else ""
    tag_labels = [t[1] for t in tags]
    kicker = " · ".join(tag_labels) if tag_labels else "Blog"
    tags_html = ""
    if tags:
        parts = []
        for variant, label in tags:
            cls = "seo-tag seo-tag--accent" if variant == "new" else "seo-tag"
            parts.append(f'<span class="{cls}">{label}</span>')
        tags_html = "    <div class=\"seo-tags\">\n      " + "\n      ".join(parts) + "\n    </div>\n"
    lead_html, prose = split_lead(body)
    new_main = f"""<main class="seo-page">
    <p class="seo-kicker">{kicker}</p>
{tags_html}    <h1>{title}</h1>
{("    " + lead_html) if lead_html else ""}
    <p class="seo-author">{meta}</p>
{SEO_CLUSTER}
    <div class="article-prose">
{prose}
    </div>
  </main>"""
    html = html[: header_m.start()] + new_main + html[header_m.end() :]
    if "site-chrome.js" not in html:
        html = html.replace(
            "</body>", '  <script src="/assets/js/site-chrome.js?v=7"></script>\n</body>'
        )
    path.write_text(html)
    print(f"OK post: {path.name}")


def convert_ai_search(path: Path) -> None:
    html = path.read_text()
    if 'class="seo-page"' in html and "article-fact-grid" in html and "sc-topbar" not in html:
        print(f"skip (already converted): {path.name}")
        return
    html = strip_inline_style(html)
    html = replace_css_links(html)
    html = re.sub(r'<body class="sc-shell-page">', "<body>", html)
    html = remove_sc_topbar(html)
    m = re.search(r'<main class="sc-content ai-search-page">(.*?)</main>', html, flags=re.S)
    if not m:
        raise SystemExit("Failed to parse ai-search main")
    main_inner = m.group(1)
    hero_m = re.search(
        r'<section class="sc-panel ai-search-hero">\s*'
        r'<span class="sc-kicker">(.*?)</span>\s*'
        r"<h2>(.*?)</h2>\s*"
        r'<p class="ai-search-lead">(.*?)</p>\s*'
        r'<nav class="sc-actions ai-search-links"[^>]*>\s*(.*?)\s*</nav>\s*'
        r"</section>",
        main_inner,
        flags=re.S,
    )
    if not hero_m:
        raise SystemExit("Failed to parse ai-search hero")
    kicker = hero_m.group(1).strip()
    title = hero_m.group(2).strip()
    lead = hero_m.group(3).strip()
    chips = re.findall(r'<a class="sc-chip" href="([^"]+)">(.*?)</a>', hero_m.group(4))
    chip_row = (
        '<div class="seo-chip-row">\n'
        + "\n".join(f'        <a href="{href}">{label}</a>' for href, label in chips)
        + "\n      </div>"
    )
    rest = main_inner[hero_m.end() :].strip()
    prose_parts = []
    for sm in re.finditer(
        r'<section class="sc-panel ai-search-section">(.*?)</section>', rest, flags=re.S
    ):
        inner = sm.group(1).strip()
        inner = re.sub(
            r'<div class="sc-grid sc-grid-2 ai-search-grid">',
            '<div class="article-fact-grid">',
            inner,
        )
        inner = re.sub(
            r'<article class="sc-card ai-search-card">',
            '<article class="article-fact-card">',
            inner,
        )
        inner = re.sub(r'\s*class="ai-search-list"', "", inner)
        inner = re.sub(r'\s*class="sc-code ai-search-code"', "", inner)
        prose_parts.append(inner)
    prose = "\n\n".join(prose_parts)
    new_main = f"""<main class="seo-page">
    <p class="seo-kicker">{kicker}</p>
    <h1>{title}</h1>
    <p class="seo-lead">{lead}</p>
{SEO_CLUSTER}
    {chip_row}
    <div class="article-prose">
{prose}
    </div>
  </main>"""
    html = html[: m.start()] + new_main + html[m.end() :]
    if "site-chrome.js" not in html:
        html = html.replace(
            "</body>", '  <script src="/assets/js/site-chrome.js?v=7"></script>\n</body>'
        )
    path.write_text(html)
    print(f"OK ai-search: {path.name}")


def main() -> None:
    for name in [
        "domain-preprocessors.html",
        "precision-mode-compression.html",
        "reversible-compression-ccr.html",
    ]:
        convert_shell_article(WEB / name)
    for name in [
        "cache-aligner-prefix-stabilization.html",
        "mcp-integration.html",
    ]:
        convert_post_article(WEB / name)
    convert_ai_search(WEB / "ai-search.html")
    print("Done")


if __name__ == "__main__":
    main()
