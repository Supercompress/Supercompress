#!/usr/bin/env python3
"""Apply landing-page header/footer chrome to every public HTML page."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
HEADER = (WEB / "assets/partials/site-header.html").read_text()
FOOTER = (WEB / "assets/partials/site-footer.html").read_text()
# Strip comment markers for injection body
HEADER_HTML = re.sub(r"<!-- SITE_HEADER_(?:START|END) -->\n?", "", HEADER).strip() + "\n"
FOOTER_HTML = re.sub(r"<!-- SITE_FOOTER_(?:START|END) -->\n?", "", FOOTER).strip() + "\n"

SKIP = {
    "web/assets/partials/site-header.html",
    "web/assets/partials/site-footer.html",
    "web/logo-dots.html",
}

CHROME_CSS = '<link rel="stylesheet" href="/assets/css/landing-chrome.css?v=6" />'
CHROME_JS = '<script src="/assets/js/site-chrome.js?v=6"></script>'


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def ensure_chrome_css(html: str) -> str:
    if "landing-chrome.css" in html:
        return re.sub(
            r'<link rel="stylesheet" href="/assets/css/landing-chrome\.css\?v=\d+"\s*/?>',
            CHROME_CSS,
            html,
            count=1,
        )
    # Insert after last stylesheet link in head, else before </head>
    links = list(re.finditer(r'<link[^>]+rel="stylesheet"[^>]*>', html, re.I))
    if links:
        last = links[-1]
        return html[: last.end()] + "\n  " + CHROME_CSS + html[last.end() :]
    return html.replace("</head>", f"  {CHROME_CSS}\n</head>", 1)


def ensure_chrome_js(html: str) -> str:
    if "site-chrome.js" in html:
        return re.sub(
            r'<script src="/assets/js/site-chrome\.js\?v=\d+"></script>',
            CHROME_JS,
            html,
        )
    if "</body>" in html:
        return html.replace("</body>", f"  {CHROME_JS}\n</body>", 1)
    return html + "\n" + CHROME_JS + "\n"


def page_hrefs(page: Path) -> set[str]:
    path = "/" + str(page.relative_to(WEB)).replace("\\", "/")
    if path.endswith("/index.html"):
        path = path[: -len("index.html")]
    elif path.endswith(".html"):
        path = path[: -len(".html")]
    path = path.rstrip("/") or "/"
    hrefs = {path, path + "/"}
    if path == "/index":
        hrefs.update({"/", "/index", "/index/"})
    return hrefs


def mark_current(html: str, page: Path) -> str:
    """Add aria-current to matching nav links for this page."""
    targets = page_hrefs(page)

    def repl(m: re.Match) -> str:
        href = m.group(1)
        tag = m.group(0)
        if "aria-current" in tag:
            return tag
        if href.startswith("http") or href.startswith("/#"):
            return tag
        norm = href.rstrip("/") or "/"
        if norm in {t.rstrip("/") or "/" for t in targets}:
            return tag[:-1] + ' aria-current="page">'
        return tag

    return re.sub(r'<a href="([^"]+)"[^>]*>', repl, html)


def replace_header(html: str) -> str:
    # Remove existing df-header (+ spacer)
    html2, n = re.subn(
        r'<header class="df-header">.*?</header>\s*(?:<div class="df-header-spacer"[^>]*></div>\s*)?',
        HEADER_HTML,
        html,
        count=1,
        flags=re.S,
    )
    if n:
        return html2

    # Remove sc-nav
    html2, n = re.subn(
        r'<nav class="sc-nav">.*?</nav>\s*',
        HEADER_HTML,
        html,
        count=1,
        flags=re.S,
    )
    if n:
        return html2

    # Playground-style bare header
    html2, n = re.subn(
        r"<header>\s*<h1>[\s\S]*?</header>\s*",
        HEADER_HTML,
        html,
        count=1,
    )
    if n:
        return html2

    # Docs top nav — keep layout but inject site header before docs-layout
    if 'class="docs-layout"' in html and 'class="df-header"' not in html:
        html = html.replace(
            '<div class="docs-layout">',
            HEADER_HTML + '<div class="docs-layout">',
            1,
        )
        # Replace docs pill links with landing set
        html = re.sub(
            r'<nav class="docs-nav-pill"[^>]*>.*?</nav>',
            """<nav class="docs-nav-pill" aria-label="Main">
              <a href="/benchmarks">Benchmarks</a>
              <a href="/#agents">Agents</a>
              <a href="/blog">Blog</a>
              <a href="/changelog">Changelog</a>
              <a href="/docs/">Docs</a>
            </nav>""",
            html,
            count=1,
            flags=re.S,
        )
        return html

    # SEO / pages with no header — insert after <body...>
    if 'class="df-header"' not in html:
        html = re.sub(
            r"(<body[^>]*>)",
            r"\1\n" + HEADER_HTML,
            html,
            count=1,
            flags=re.I,
        )
    return html


def replace_footer(html: str) -> str:
    html2, n = re.subn(
        r"<footer class=\"df-footer\">.*?</footer>",
        FOOTER_HTML.rstrip(),
        html,
        count=1,
        flags=re.S,
    )
    if n:
        return html2

    # Generic footer tags
    html2, n = re.subn(
        r"<footer\b[^>]*>.*?</footer>",
        FOOTER_HTML.rstrip(),
        html,
        count=1,
        flags=re.S,
    )
    if n:
        return html2

    # Insert before chrome js / body end
    if 'class="df-footer"' not in html:
        if CHROME_JS in html:
            return html.replace(CHROME_JS, FOOTER_HTML + "  " + CHROME_JS, 1)
        if "</body>" in html:
            return html.replace("</body>", FOOTER_HTML + "</body>", 1)
    return html


def strip_seo_chrome_nav(html: str) -> str:
    """Remove in-page seo-nav that duplicates site header links."""
    return re.sub(
        r'\s*<nav class="seo-nav"[^>]*>.*?</nav>\s*',
        "\n",
        html,
        count=1,
        flags=re.S,
    )


def process(path: Path) -> bool:
    rel_path = rel(path)
    if rel_path in SKIP:
        return False
    original = path.read_text(encoding="utf-8", errors="ignore")
    html = original
    html = ensure_chrome_css(html)
    html = replace_header(html)
    html = strip_seo_chrome_nav(html)
    html = replace_footer(html)
    html = ensure_chrome_js(html)
    # Index: keep in-page #agents as /#agents already in partial; sync index header too
    if path.name == "index.html" and path.parent == WEB:
        html = html.replace('href="#agents"', 'href="/#agents"')
    html = mark_current(html, path)
    if html != original:
        path.write_text(html, encoding="utf-8")
        return True
    return False


def main() -> None:
    changed = []
    for path in sorted(WEB.rglob("*.html")):
        if "partials" in path.parts:
            continue
        if process(path):
            changed.append(rel(path))
    print(f"updated {len(changed)} pages")
    for c in changed:
        print(" ", c)


if __name__ == "__main__":
    main()
