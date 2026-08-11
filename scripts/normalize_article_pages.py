#!/usr/bin/env python3
"""Normalize SEO / guide / blog article pages onto article-page.css."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"

SKIP = {
    "index.html",
    "dashboard.html",
    "analytics.html",
    "playground.html",
    "live-demo.html",
    "benchmarks.html",
    "blog.html",
    "changelog.html",
    "affiliates.html",
    "affiliate-creator-kit.html",
    "founder.html",
    "404.html",
    "research.html",
    "compare.html",
    "aiscore.html",
    "launch-kit.html",
    "logo-dots.html",
    "unsubscribe.html",
}

CSS_BLOCK = """<link rel="stylesheet" href="assets/css/supercompress.css?v=105" />
  <link rel="stylesheet" href="/assets/css/landing-chrome.css?v=12" />
  <link rel="stylesheet" href="/assets/css/seo-cluster.css?v=2" />
  <link rel="stylesheet" href="/assets/css/article-page.css?v=2" />"""

STYLE_RE = re.compile(r"\n?\s*<style\b[^>]*>.*?</style>\s*", re.S | re.I)
LINK_RE = re.compile(
    r'\s*<link\s+rel="stylesheet"\s+href="[^"]*(?:supercompress|landing-chrome|seo-cluster|seo-article|article-page|content-shell)\.css[^"]*"\s*/?>\s*',
    re.I,
)


def should_strip_style(css: str) -> bool:
    """Strip style blocks that are article/SEO chrome (keep rare page-specific JS/CSS)."""
    markers = (
        ".seo-page",
        ".seo-kicker",
        ".seo-lead",
        ".seo-section",
        ".seo-table",
        ".seo-cta",
        ".seo-author",
        ".seo-nav",
        ".guide-head",
        ".guide-toc",
        ".guide-body",
        ".guide-cta",
        ".guide-methods",
        ".method-card",
        ".article-prose",
        ".post-header",
        ".post-content",
        ".seo-verdict",
        ".seo-cluster",
    )
    hits = sum(1 for m in markers if m in css)
    # Keep if it's mostly something else (affiliates, dashboard-ish)
    if hits >= 2:
        return True
    if ".guide-head" in css or ".guide-body" in css:
        return True
    return False


def ensure_css_links(html: str) -> str:
    html = LINK_RE.sub("\n", html)
    # Insert after favicon / before first script or remaining link, prefer after apple-touch
    anchor = re.search(
        r'(<link rel="apple-touch-icon"[^>]*>\s*)',
        html,
        re.I,
    )
    block = CSS_BLOCK + "\n"
    if anchor:
        return html[: anchor.end()] + block + html[anchor.end() :]
    # fallback: before </head>
    return html.replace("</head>", block + "</head>", 1)


def strip_article_styles(html: str) -> str:
    def repl(m: re.Match) -> str:
        css = m.group(0)
        if should_strip_style(css):
            return "\n"
        return css

    return STYLE_RE.sub(repl, html)


def convert_guide_head(html: str) -> str:
    """Map guide-head pages into seo-page shell without destroying TOC/body."""
    if 'class="guide-head"' not in html:
        return html

    # Normalize kicker / subtitle / meta classes inside guide-head
    html = html.replace('<header class="guide-head">', '<main class="seo-page">')
    # Close guide-head early if it wraps proof sections — keep structure but rename
    # Many guides close </header> after meta; convert that to stay inside main.
    html = re.sub(
        r'<p class="kicker">(.*?)</p>',
        r'<p class="seo-kicker">\1</p>',
        html,
        count=1,
        flags=re.S,
    )
    html = re.sub(
        r'<p class="subtitle">(.*?)</p>',
        r'<p class="seo-lead">\1</p>',
        html,
        count=1,
        flags=re.S,
    )
    html = re.sub(
        r'<p class="meta">(.*?)</p>\s*</header>',
        r'<p class="seo-author">\1</p>',
        html,
        count=1,
        flags=re.S,
    )
    # If header still open/closed oddly, fix leftover </header> after guide-head start
    # Already handled above when meta closes header.

    # Ensure guide-body is present; if main never closed, close before footer
    if '<main class="seo-page">' in html and "</main>" not in html.split('<main class="seo-page">', 1)[1].split("<footer", 1)[0]:
        html = re.sub(
            r"(</div>\s*)?(<footer\b)",
            r"</main>\n\1\2",
            html,
            count=1,
            flags=re.I,
        )
    return html


def ensure_site_chrome_js(html: str) -> str:
    if "site-chrome.js" in html:
        html = re.sub(
            r'/assets/js/site-chrome\.js\?v=\d+',
            "/assets/js/site-chrome.js?v=12",
            html,
        )
        return html
    return html.replace(
        "</body>",
        '  <script src="/assets/js/site-chrome.js?v=12"></script>\n</body>',
        1,
    )


def process(path: Path) -> str:
    html = path.read_text(encoding="utf-8")
    original = html
    html = strip_article_styles(html)
    html = ensure_css_links(html)
    html = convert_guide_head(html)
    html = ensure_site_chrome_js(html)
    # Deduplicate accidental blank lines
    html = re.sub(r"\n{3,}", "\n\n", html)
    if html == original:
        return "unchanged"
    path.write_text(html, encoding="utf-8")
    return "updated"


def main() -> None:
    updated = []
    skipped = []
    for path in sorted(WEB.glob("*.html")):
        if path.name in SKIP:
            skipped.append(path.name)
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        # Only touch marketing/SEO-ish pages
        markers = (
            "seo-page",
            "guide-head",
            "guide-body",
            "article-prose",
            "post-header",
            "seo-section",
            "seo-cluster",
            "article-page.css",
        )
        if not any(m in text for m in markers) and "<style>" not in text:
            skipped.append(path.name)
            continue
        # Skip pure product shells that happen to include style for other reasons
        if path.name in {"coding-agent-proxy.html"} or "guide-head" in text or "seo-page" in text or "seo-section" in text or "guide-body" in text:
            status = process(path)
            updated.append((path.name, status))
        elif any(m in text for m in ("seo-kicker", "seo-lead", "seo-table", "seo-cta")):
            status = process(path)
            updated.append((path.name, status))
        else:
            # Still strip if heavy seo inline
            if re.search(r"<style>[\s\S]*?\.seo-page[\s\S]*?</style>", text):
                status = process(path)
                updated.append((path.name, status))
            else:
                skipped.append(path.name)

    print("Updated:")
    for name, status in updated:
        print(f"  {status:9} {name}")
    print(f"\nTouched {sum(1 for _, s in updated if s == 'updated')} files")


if __name__ == "__main__":
    main()
