#!/usr/bin/env python3
"""Apply landing-page header/footer chrome to every public marketing HTML page.

Canonical sources:
  web/assets/partials/site-header.html
  web/assets/partials/site-footer.html

Skipped:
  - docs/* (sidebar docs chrome)
  - dashboard.html header (keeps account profile UI; footer still synced)
  - partials themselves
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
HEADER = (WEB / "assets/partials/site-header.html").read_text(encoding="utf-8")
FOOTER = (WEB / "assets/partials/site-footer.html").read_text(encoding="utf-8")
SIGNUP_CTA = (WEB / "assets/partials/signup-cta.html").read_text(encoding="utf-8")
# Strip comment markers for injection body
HEADER_HTML = re.sub(r"<!-- SITE_HEADER_(?:START|END) -->\n?", "", HEADER).strip() + "\n"
FOOTER_HTML = re.sub(r"<!-- SITE_FOOTER_(?:START|END) -->\n?", "", FOOTER).strip() + "\n"
# Pre-footer signup band removed (was unstyled / no CSS).
SIGNUP_CTA_HTML = ""

SKIP_PATHS = {
    "web/assets/partials/site-header.html",
    "web/assets/partials/site-footer.html",
    "web/assets/partials/signup-cta.html",
    "web/logo-dots.html",
    "web/assets/partials/seo-cluster.html",
}

# Signup CTA injection disabled site-wide
SKIP_SIGNUP_CTA = {
    "web/index.html",
    "web/dashboard.html",
    "web/unsubscribe.html",
}

CHROME_CSS = '<link rel="stylesheet" href="/assets/css/landing-chrome.css?v=12" />'
CHROME_JS = '<script src="/assets/js/site-chrome.js?v=12"></script>'


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def is_docs_page(path: Path) -> bool:
    try:
        path.relative_to(WEB / "docs")
        return True
    except ValueError:
        return False


def is_dashboard(path: Path) -> bool:
    return path.name == "dashboard.html" and path.parent == WEB


def ensure_chrome_css(html: str) -> str:
    if "landing-chrome.css" in html:
        return re.sub(
            r'<link rel="stylesheet" href="/assets/css/landing-chrome\.css\?v=\d+"\s*/?>',
            CHROME_CSS,
            html,
            count=1,
        )
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
    # Marker-wrapped blocks
    html2, n = re.subn(
        r"<!-- SITE_HEADER_START -->.*?<!-- SITE_HEADER_END -->\s*",
        HEADER_HTML,
        html,
        count=1,
        flags=re.S,
    )
    if n:
        return html2

    # Existing df-header (+ spacer)
    html2, n = re.subn(
        r'<header class="df-header">.*?</header>\s*(?:<div class="df-header-spacer"[^>]*></div>\s*)?',
        HEADER_HTML,
        html,
        count=1,
        flags=re.S,
    )
    if n:
        return html2

    # Legacy sc-nav
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

    # Pages with no header — insert after <body...>
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
        r"<!-- SITE_FOOTER_START -->.*?<!-- SITE_FOOTER_END -->",
        FOOTER_HTML.rstrip(),
        html,
        count=1,
        flags=re.S,
    )
    if n:
        return html2

    html2, n = re.subn(
        r'<footer class="df-footer">.*?</footer>',
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


def ensure_signup_cta(html: str) -> str:
    """Remove legacy unstyled signup bands / seo CTAs (do not re-inject)."""
    html = re.sub(
        r"<!-- SITE_SIGNUP_CTA_START -->.*?<!-- SITE_SIGNUP_CTA_END -->\s*",
        "",
        html,
        flags=re.S,
    )
    html = re.sub(
        r'<(?:section|aside) class="sc-signup-band[^"]*"[^>]*>.*?</(?:section|aside)>\s*',
        "",
        html,
        flags=re.S,
    )
    html = re.sub(
        r'<(?:section|aside|div) class="seo-cta"[^>]*>.*?</(?:section|aside|div)>\s*',
        "",
        html,
        flags=re.S,
    )
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
    if rel_path in SKIP_PATHS:
        return False
    if is_docs_page(path):
        return False

    original = path.read_text(encoding="utf-8", errors="ignore")
    html = original
    is_landing = path.name == "index.html" and path.parent == WEB
    dashboard = is_dashboard(path)

    # Keep chrome CSS cache-bust in sync on every page (including landing)
    html = ensure_chrome_css(html)

    # Dashboard keeps its auth/profile header; unify footer only
    if not dashboard:
        html = replace_header(html)
        html = strip_seo_chrome_nav(html)

    html = replace_footer(html)

    # Always strip legacy unstyled pre-footer signup bands
    html = ensure_signup_cta(html)

    if not is_landing and not dashboard:
        html = ensure_chrome_js(html)
    elif is_landing:
        html = ensure_chrome_js(html)

    if is_landing:
        html = html.replace('href="#features"', 'href="/#features"')
        html = html.replace('href="#coding-agents"', 'href="/#coding-agents"')
        html = html.replace('href="#demo"', 'href="/#demo"')
        html = html.replace(
            'href="/#demo" class="btn-link-muted"',
            'href="#demo" class="btn-link-muted"',
            1,
        )

    if not dashboard:
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
