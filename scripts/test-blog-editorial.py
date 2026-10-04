#!/usr/bin/env python3
"""Blog regression checks: lossless migration, canonical index, local assets.

By default compare articles against HEAD; pass --base REV after committing.
No network or browser is used. Existing prose links are deliberately preserved.
"""
import argparse
import json
import re
import subprocess
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, unquote

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / 'web'


class Page(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.tags = []
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', default='HEAD')
    args = parser.parse_args()
    articles = sorted(p for p in WEB.glob('*.html') if 'article-page.css' in p.read_text())
    assert len(articles) == 37
    canonicals = set()
    for path in articles:
        current = path.read_text()
        original = subprocess.check_output(['git', 'show', f'{args.base}:web/{path.name}'], cwd=ROOT, text=True)
        restored = current.replace('  <link rel="stylesheet" href="/assets/css/blog-editorial.css?v=1" />\n', '')
        restored = restored.replace(' data-editorial="article"', '').replace(' data-article-content', '')
        restored = restored.replace('<script src="/assets/js/blog-editorial.js?v=1" defer></script>\n', '')
        if '<main' not in original:
            restored = restored.replace('<main class="seo-page">', '<div class="container">', 1)
            restored = re.sub(r'</main>(\s*<footer)', r'</div>\1', restored, count=1)
        assert restored == original, f'Content or metadata changed: {path.name}'
        page = Page(current)
        mains = [attrs for tag, attrs in page.tags if tag == 'main']
        assert len(mains) == 1 and 'data-article-content' in mains[0], path.name
        canonical = next(attrs['href'] for tag, attrs in page.tags if tag == 'link' and attrs.get('rel') == 'canonical')
        parsed = urlsplit(canonical)
        if parsed.hostname in ('supercompress.dev', 'www.supercompress.dev'):
            canonicals.add(parsed.path)
        assert current.rfind('blog-editorial.css') > current.rfind('</style>'), path.name
    source = (WEB / 'blog.html').read_text()
    page = Page(source)
    links = [a['href'] for t, a in page.tags if t == 'a']
    article_links = [link for link in links if link in canonicals]
    assert len(article_links) == len(set(article_links)) == 36
    assert set(article_links) == canonicals
    assert len([a for t, a in page.tags if 'data-blog-card' in a]) == 36
    redirects = {r['source'] for r in json.loads((ROOT / 'vercel.json').read_text())['redirects'] if not r.get('has')}
    for link in article_links:
        assert link not in redirects, link
    for tag, attrs in page.tags:
        resource = attrs.get('src') or attrs.get('href', '')
        path = unquote(urlsplit(resource).path)
        if not resource.startswith('/') or path == '/':
            continue
        assert (WEB / path.lstrip('/')).exists() or (WEB / (path.lstrip('/') + '.html')).exists(), resource
    css = (WEB / 'assets/css/blog-editorial.css').read_text()
    for asset in re.findall(r"url\('([^']+)'\)", css):
        assert (WEB / asset.lstrip('/')).is_file(), asset
    assert '[hidden]{display:none!important}' in css
    assert 'prefers-reduced-motion' in css
    print('PASS: 37 lossless article migrations; 36 unique canonical index links; local links and font assets resolve.')


if __name__ == '__main__':
    main()
