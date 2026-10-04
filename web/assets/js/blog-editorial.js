/* Content and links work without JavaScript. Controls appear only when ready. */
(() => {
  const form = document.querySelector('.journal-search');
  if (form) {
    const cards = [...document.querySelectorAll('[data-blog-card]')];
    const search = form.elements.q;
    const topic = form.elements.topic;
    const filter = () => {
      const words = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      let count = 0;
      cards.forEach(card => {
        card.hidden = !words.every(word => card.textContent.toLocaleLowerCase().includes(word)) || Boolean(topic.value && card.dataset.category !== topic.value);
        if (!card.hidden) count++;
      });
      document.querySelector('[data-result-count]').textContent = `${count} ${count === 1 ? 'article' : 'articles'}`;
      document.querySelector('.journal-empty').hidden = count !== 0;
    };
    form.hidden = false;
    form.addEventListener('submit', event => event.preventDefault());
    form.addEventListener('input', filter);
    form.addEventListener('change', filter);
    form.addEventListener('reset', () => setTimeout(filter, 0));
  }
  const article = document.querySelector('[data-article-content]');
  if (!article) return;
  const back = document.createElement('a');
  back.href = '/blog';
  back.className = 'editorial-back';
  back.textContent = '← All stories';
  article.prepend(back);
  const headings = [...article.querySelectorAll('h2')].filter(h => !h.closest('.toc, .guide-toc, .article-toc, .seo-cta, .article-cta'));
  headings.forEach((heading, index) => {
    if (heading.id) return;
    const base = heading.textContent.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `section-${index + 1}`;
    let id = base;
    let suffix = 2;
    while (document.getElementById(id)) id = `${base}-${suffix++}`;
    heading.id = id;
  });
  if (headings.length > 2 && !article.querySelector('.toc, .guide-toc, .article-toc')) {
    const toc = document.createElement('details');
    toc.className = 'editorial-toc';
    const summary = document.createElement('summary');
    summary.textContent = 'On this page';
    const nav = document.createElement('nav');
    nav.setAttribute('aria-label', 'Table of contents');
    const list = document.createElement('ol');
    headings.forEach(heading => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = `#${heading.id}`;
      link.textContent = heading.textContent;
      item.append(link);
      list.append(item);
    });
    nav.append(list);
    toc.append(summary, nav);
    // Insert before the first content section, outside its heading wrapper.
    let anchor = headings[0];
    while (anchor.parentElement !== article) anchor = anchor.parentElement;
    article.insertBefore(toc, anchor);
  }
  if (navigator.clipboard && window.isSecureContext) {
    article.querySelectorAll('pre').forEach(pre => {
      const wrapper = document.createElement('div');
      wrapper.className = 'editorial-code';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'editorial-copy';
      copy.textContent = 'Copy code';
      copy.setAttribute('aria-label', 'Copy code to clipboard');
      copy.setAttribute('aria-live', 'polite');
      pre.before(wrapper);
      wrapper.append(pre, copy);
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(pre.textContent);
          copy.textContent = 'Copied';
        } catch {
          copy.textContent = 'Select code to copy';
        }
        setTimeout(() => { copy.textContent = 'Copy code'; }, 2500);
      });
    });
  }
})();
