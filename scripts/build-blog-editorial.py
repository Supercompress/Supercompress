#!/usr/bin/env python3
"""Emit an apply_patch patch for the blog index and article shells; never write files.

Run from the repository root. Article prose and head metadata are kept verbatim.
The source of truth is the released HTML, excluding unconditional redirects.
"""
import html
import difflib
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / 'web'
CSS = '<link rel="stylesheet" href="/assets/css/blog-editorial.css?v=1" />'
JS = '<script src="/assets/js/blog-editorial.js?v=1" defer></script>'


def plain(value):
    return html.unescape(re.sub('<[^>]+>', '', value)).strip()


def field(source, pattern):
    match = re.search(pattern, source, re.S)
    return match.group(1) if match else ''


def category(slug):
    if any(x in slug for x in ('headroom', '-vs-', 'alternatives')):
        return 'Comparisons'
    if any(x in slug for x in ('cost', 'reduce-')):
        return 'Cost optimization'
    if any(x in slug for x in ('mcp-', 'launch')):
        return 'Product notes'
    if any(x in slug for x in ('agent', 'firecrawl', 'architecture')):
        return 'Engineering'
    return 'Guides'


def patch(path, old, new):
    if old != new:
        print('*** Update File: ' + str(path))
        diff = list(difflib.unified_diff(old.splitlines(), new.splitlines(), n=3, lineterm=''))
        for line in diff[2:]:
            print('@@' if line.startswith('@@') else line)


def main():
    redirects = {r['source']: r['destination'] for r in json.loads((ROOT / 'vercel.json').read_text())['redirects'] if not r.get('has')}
    articles = []
    changes = []
    for path in sorted(WEB.glob('*.html')):
        old = path.read_text()
        if 'article-page.css' not in old:
            continue
        canonical = field(old, r'<link rel="canonical" href="([^"]+)"')
        route = urlsplit(canonical).path
        title = plain(field(old, r'<h1[^>]*>(.*?)</h1>'))
        description = plain(field(old, r'<meta name="description" content="([^"]*)"'))
        if route == '/' + path.stem and route not in redirects and urlsplit(canonical).hostname in ('supercompress.dev', 'www.supercompress.dev'):
            articles.append(dict(route=route, title=title, description=description, category=category(path.stem)))
        new = old
        if 'blog-editorial.css' not in new:
            new = new.replace('</head>', '  ' + CSS + '\n</head>', 1)
            new = re.sub(r'<body([^>]*)>', r'<body\1 data-editorial="article">', new, count=1)
            if '<main' not in new:
                new = new.replace('<div class="container">', '<main class="seo-page">', 1)
                new, count = re.subn(r'</div>(\s*<footer)', r'</main>\1', new, count=1)
                assert count == 1, path.name
            new = re.sub(r'<main([^>]*)>', r'<main\1 data-article-content>', new, count=1)
            new = new.replace('</body>', JS + '\n</body>', 1)
        changes.append((path, old, new))
    assert len(changes) == 37, len(changes)
    assert len(articles) == 36, len(articles)
    index = WEB / 'blog.html'
    old = index.read_text()
    head = old.split('</head>')[0]
    head = re.sub(r'<style\b[^>]*>.*?</style>', '', head, flags=re.S)
    head = re.sub(r'<link rel="stylesheet"[^>]*>', '', head)
    head = re.sub(r'<meta name="description"[^>]*>', '<meta name="description" content="Field notes on building with less context. Guides, engineering, comparisons, and product updates from SuperCompress." />', head)
    head = re.sub(r'<meta name="twitter:description"[^>]*>', '<meta name="twitter:description" content="Guides, engineering, and field notes on context compression from SuperCompress." />', head)
    featured = next(a for a in articles if a['route'] == '/mcp-oauth')
    ordered = [featured] + [a for a in articles if a != featured]
    cards = []
    for n, a in enumerate(ordered):
        esc = lambda key: html.escape(a[key], quote=True)
        cards.append(f'''<article class="journal-card{' journal-feature' if n == 0 else ''}" data-blog-card data-category="{esc('category')}">
        <p class="journal-label">{'Latest dispatch · ' if n == 0 else ''}{esc('category')}</p>
        <h2><a href="{esc('route')}">{esc('title')}</a></h2>
        <p class="journal-description">{esc('description')}</p>
        <span class="journal-read" aria-hidden="true">Read the story ↗</span>
      </article>''')
    filters = ''.join(f'<option>{html.escape(c)}</option>' for c in sorted({a['category'] for a in articles}))
    head = '\n'.join(line.rstrip() for line in head.splitlines())
    new = head.rstrip() + '\n  ' + CSS + '''
</head>
<body data-editorial="index">
  <a class="journal-skip" href="#journal">Skip to articles</a>
  <header class="journal-nav">
    <a class="journal-brand" href="/" aria-label="SuperCompress home"><img src="/assets/img/logo-chevrons.png" width="26" height="26" alt="" />SuperCompress</a>
    <nav aria-label="Main navigation"><a href="/blog" aria-current="page">Journal</a><a href="https://docs.supercompress.dev">Docs</a><a href="/dashboard?signup=1">Get started ↗</a></nav>
  </header>
  <main id="journal" class="journal">
    <header class="journal-hero">
      <div><p class="journal-label">The SuperCompress journal</p>
      <h1>Less context.<br><em>More signal.</em></h1>
      <p>Field notes on making AI work better. Engineering, practical guides, and ideas from the people building SuperCompress.</p></div>
      <img class="journal-art" src="/assets/img/hero-stipple-hands-web.png" width="560" height="560" alt="" fetchpriority="high" />
    </header>
    <section aria-label="Article library">
      <div class="journal-library-heading"><h2>From the journal</h2><p data-result-count aria-live="polite">36 articles</p></div>
      <form class="journal-search" role="search" hidden>
        <label>Find a story<input type="search" name="q" placeholder="Search articles…" autocomplete="off" /></label>
        <label>Explore a topic<select name="topic"><option value="">All topics</option>''' + filters + '''</select></label>
        <button type="reset">Clear filters</button>
      </form>
      <div class="journal-grid">
      ''' + '\n      '.join(cards) + '''
      </div>
      <p class="journal-empty" hidden>No articles match. Try a different search or clear the filters.</p>
    </section>
    <aside class="journal-endnote"><p class="journal-label">Put it into practice</p><h2>Make room for what matters.</h2><p>Bring context compression to your next build.</p><a href="https://docs.supercompress.dev">Explore the documentation ↗</a></aside>
  </main>
  <footer class="journal-footer"><a class="journal-brand" href="/">SuperCompress</a><p>Good context changes everything.</p><nav aria-label="Footer"><a href="/changelog">Changelog</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav></footer>
  ''' + JS + '\n</body>\n</html>\n'
    print('*** Begin Patch')
    for args in changes:
        patch(*args)
    patch(index, old, new)
    print('*** End Patch')


if __name__ == '__main__':
    main()
