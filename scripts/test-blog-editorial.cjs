/* Isolated headless checks; never attaches to a shared browser/profile.
 * Run: node scripts/test-blog-editorial.cjs
 * BLOG_PLAYWRIGHT_MODULE may point to an existing Playwright installation.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.BLOG_PLAYWRIGHT_MODULE || 'playwright');
const web = path.resolve(__dirname, '../web');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let file = path.join(web, decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!path.extname(file)) file += '.html';
  if (!file.startsWith(web + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    // No analytics or external requests during local verification.
    await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const articles = fs.readdirSync(web).filter(f => f.endsWith('.html') && fs.readFileSync(path.join(web, f), 'utf8').includes('article-page.css'));
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const file of ['blog.html', ...articles]) {
        await page.goto(`${origin}/${file}`);
        await page.evaluate(() => document.fonts.ready);
        const layout = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          heading: getComputedStyle(document.querySelector('h1')).fontFamily,
          paper: getComputedStyle(document.body).backgroundColor,
        }));
        assert.equal(layout.overflow, false, `${file} overflows at ${width}`);
        assert.match(layout.heading, /Platypi/, file);
        assert.equal(layout.paper, 'rgb(251, 251, 248)', file);
      }
    }
    await page.goto(`${origin}/blog`);
    await page.locator('input[name=q]').fill('OAuth');
    assert.equal(await page.locator('[data-blog-card]:visible').count(), 1);
    await page.locator('input[name=q]').fill('no-such-story-1234');
    assert.equal(await page.locator('[data-blog-card]:visible').count(), 0);
    assert.equal(await page.locator('.journal-empty').isVisible(), true);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-blog-card]:not([hidden])').length === 36);
    await page.locator('select[name=topic]').selectOption('Engineering');
    assert.ok(await page.locator('[data-blog-card]:visible').count() > 0);
    assert.equal(await page.locator('[data-blog-card]:visible:not([data-category="Engineering"])').count(), 0);
    await page.goto(`${origin}/mcp-oauth`);
    await page.locator('.editorial-toc summary').click();
    const destinations = await page.locator('.editorial-toc a').evaluateAll(links => links.every(link => document.getElementById(link.hash.slice(1))));
    assert.equal(destinations, true);
    const code = await page.locator('pre').first().textContent();
    await page.getByRole('button', { name: 'Copy code to clipboard' }).first().click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), code);
    // Exercise rich text even when a given article doesn't use every element.
    await page.locator('[data-article-content]').evaluate(article => {
      const fixture = document.createElement('section');
      fixture.id = 'rich-text-fixture';
      fixture.innerHTML = '<p><strong>Bold</strong> <em>Italic</em> <del>Deleted</del> <mark>Marked</mark> <a href="#rich-text-fixture">Link</a></p><figure><img src="/assets/img/architecture.svg" width="1600" alt="Architecture"><figcaption>Caption</figcaption></figure><blockquote><p>Quotation</p></blockquote><ul><li>List item</li></ul><pre><code>' + 'long code line '.repeat(100) + '</code></pre><table><tr><th>Heading</th><td>' + 'long table value '.repeat(30) + '</td></tr></table>';
      article.append(fixture);
    });
    await page.setViewportSize({ width: 375, height: 900 });
    const rich = await page.locator('#rich-text-fixture').evaluate(el => ({
      weight: getComputedStyle(el.querySelector('strong')).fontWeight,
      italic: getComputedStyle(el.querySelector('em')).fontStyle,
      font: getComputedStyle(el.querySelector('p')).fontFamily,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    }));
    assert.equal(rich.weight, '700');
    assert.equal(rich.italic, 'italic');
    assert.match(rich.font, /Geist/);
    assert.equal(rich.overflow, false);
    const noJS = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 375, height: 900 } });
    const staticPage = await noJS.newPage();
    await staticPage.goto(`${origin}/blog`);
    assert.equal(await staticPage.locator('[data-blog-card]:visible').count(), 36);
    assert.equal(await staticPage.locator('.journal-search').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('PASS: 38 pages at 375/1280px; typography; search/filter/reset; TOC; clipboard; rich text; no-JS index.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
