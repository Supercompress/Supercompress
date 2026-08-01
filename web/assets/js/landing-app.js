(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hasGsap = Boolean(window.gsap && window.ScrollTrigger);
  if (hasGsap && !reduced) document.documentElement.classList.add('gsap-ready');

  // Scroll progress
  window.addEventListener('scroll', () => {
    const prog = document.querySelector('.scroll-progress');
    if (prog) {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      prog.style.width = `${max > 0 ? (window.scrollY / max) * 100 : 0}%`;
    }
  }, { passive: true });

  // Mobile nav (new chrome)
  const menuBtn = document.querySelector('.df-menu-btn');
  const mobileNav = document.getElementById('df-mobile-nav');
  const closeMobile = () => {
    mobileNav?.classList.remove('is-open');
    menuBtn?.setAttribute('aria-expanded', 'false');
  };
  menuBtn?.addEventListener('click', () => {
    const open = mobileNav?.classList.toggle('is-open');
    menuBtn.setAttribute('aria-expanded', String(Boolean(open)));
  });
  mobileNav?.querySelectorAll('a').forEach((a) => a.addEventListener('click', closeMobile));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMobile();
  });

  // Header elevates after scroll
  const header = document.querySelector('.df-header');
  if (header) {
    const syncHeader = () => {
      header.classList.toggle('is-scrolled', window.scrollY > 12);
    };
    window.addEventListener('scroll', syncHeader, { passive: true });
    syncHeader();
  }

  // Smooth in-page anchors (respect reduced motion)
  if (!reduced) {
    document.querySelectorAll('a[href^="#"], a[href^="/#"]').forEach((a) => {
      a.addEventListener('click', (e) => {
        const href = a.getAttribute('href') || '';
        const id = href.includes('#') ? href.split('#').pop() : '';
        if (!id) return;
        // Only intercept when target is on this page
        if (href.startsWith('/#') && location.pathname !== '/') return;
        const target = document.getElementById(id);
        if (!target) return;
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        history.pushState(null, '', `#${id}`);
        closeMobile();
      });
    });
  }

  // Launch video unmute
  const frame = document.getElementById('launch-video-frame');
  const video = frame?.querySelector('video');
  const soundBtn = document.getElementById('launch-video-sound');
  if (frame && video) {
    const markPlaying = () => frame.classList.add('is-playing');
    video.addEventListener('playing', markPlaying);
    if (!video.paused) markPlaying();
    soundBtn?.addEventListener('click', async () => {
      const muted = !video.muted;
      video.muted = muted;
      if (!muted) {
        try { await video.play(); } catch (_) { /* */ }
      }
      soundBtn.textContent = muted ? 'Unmute' : 'Mute';
    });
  }

  // —— Bayer dither canvases ——
  const BAYER8 = [
    [0,32,8,40,2,34,10,42],[48,16,56,24,50,18,58,26],
    [12,44,4,36,14,46,6,38],[60,28,52,20,62,30,54,22],
    [3,35,11,43,1,33,9,41],[51,19,59,27,49,17,57,25],
    [15,47,7,39,13,45,5,37],[63,31,55,23,61,29,53,21]
  ];
  const fieldFns = {
    compress: (x, y, t, w, h) => {
      const d = Math.hypot(x - w * .5, y - h * .55) / Math.max(w, h);
      const pulse = .5 + .5 * Math.sin(t * 1.35);
      return .18 + (1 - d) * (.62 + pulse * .22) + (.5 + .5 * Math.sin(d * 18 - t * 2.2)) * .12 * (1 - d);
    },
    dropin: (x, y, t, w, h) => {
      const gx = Math.floor(x / 8) * 8, gy = Math.floor(y / 8) * 8;
      return .3 + Math.sin((gx + gy) * .1 + t * 1.6) * .34 + (y / h) * .18;
    },
    private: (x, y, t, w, h) => {
      const veil = .5 + .5 * Math.sin(x * .05 + t * .85) * Math.cos(y * .06 - t * .6);
      const edge = Math.min(x / w, y / h, 1 - x / w, 1 - y / h);
      return .16 + veil * .52 * Math.min(1, edge * 5);
    },
    agents: (x, y, t, w, h) => {
      const cx = w * .5, cy = h * .5;
      const ang = Math.atan2(y - cy, x - cx);
      const d = Math.hypot(x - cx, y - cy) / Math.max(w, h);
      return .22 + (1 - d) * .35 + (.5 + .5 * Math.sin(ang * 4 + t * 1.2)) * .2 * d + (.5 + .5 * Math.sin(d * 22 - t * 1.8)) * .18;
    },
    chat: (x, y, t, w, h) => {
      const wave = Math.sin(x * .07 + t * 1.8) * (h * .2);
      const band = 1 - Math.min(1, Math.abs(y - (h * .52 + wave)) / (h * .2));
      return .14 + band * .7;
    },
    docs: (x, y, t, w, h) => {
      const col = Math.floor(x / (w / 8));
      const hgt = (.3 + .55 * Math.abs(Math.sin(col * 1.15 + t * 1.05))) * h;
      return y > h - hgt ? .8 - (h - y) / hgt * .4 : .1;
    },
    flow: (x, y, t, w, h) => {
      const u = x / w, v = y / h;
      return .24 + Math.sin((u - .5) * 7 + t * 1.1) * Math.cos((v - .5) * 6 - t * .85) * .36 + (1 - v) * .18;
    }
  };

  function paintDither(canvas, mode, t) {
    const parent = canvas.parentElement;
    if (!parent) return;
    const cssW = parent.clientWidth || canvas.clientWidth || 320;
    const cssH = parent.clientHeight || canvas.clientHeight || 150;
    const isVisionEdge = canvas.classList.contains('vision-dither-left')
      || canvas.classList.contains('vision-dither-right');
    const scale = canvas.classList.contains('orbit-dither')
      || canvas.classList.contains('pipeline-dither')
      ? 4
      : (canvas.classList.contains('terminal-dither')
        || canvas.classList.contains('neural-dither')
        || canvas.classList.contains('install-dither')
        || canvas.classList.contains('cta-dither')
        || canvas.classList.contains('cta-band-dither')
          ? 3.2
          : (canvas.classList.contains('micro-dither')
            || canvas.classList.contains('micro-dither-strip')
            || canvas.classList.contains('dash-shell-dither')
            || canvas.classList.contains('post-hero-dither')
            || canvas.classList.contains('vision-dither')
            || canvas.classList.contains('hero-dither')
            || canvas.classList.contains('usecase-dither')
            || canvas.classList.contains('cta-aside-dither')
            || canvas.classList.contains('pipeline-meter-dither')
            || canvas.classList.contains('footer-dither')
              ? (isVisionEdge ? 3.2 : 3.6)
              : 2.5));
    // Vision side panels size to themselves, not the full sticky parent
    const boxW = isVisionEdge ? (canvas.clientWidth || cssW * 0.3) : cssW;
    const boxH = isVisionEdge ? (canvas.clientHeight || cssH) : cssH;
    const w = Math.max(48, Math.floor(boxW / scale));
    const h = Math.max(28, Math.floor(boxH / scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d', { alpha: isVisionEdge });
    const img = ctx.createImageData(w, h);
    const data = img.data;
    const fn = fieldFns[mode] || fieldFns.flow;
    const dark = canvas.classList.contains('dither-dark');
    const paper = dark ? [18, 18, 20] : [247, 245, 241];
    const ink = dark ? [90, 150, 255] : [5, 70, 180];
    const fromLeft = canvas.classList.contains('vision-dither-left');
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = Math.max(0, Math.min(1, fn(x, y, t, w, h)));
        const bayer = (BAYER8[y & 7][x & 7] + .5) / 64;
        const on = v > bayer;
        const i = (y * w + x) * 4;
        if (isVisionEdge) {
          // Spiky inward fade: dense at outer edge, speckles die toward middle
          const u = fromLeft ? (x / Math.max(w - 1, 1)) : (1 - x / Math.max(w - 1, 1));
          // soft falloff + Bayer jitter so the edge looks toothed, not a hard rectangle
          const fall = Math.max(0, 1 - Math.pow(u / 0.92, 1.35));
          const tooth = (bayer - 0.5) * 0.55;
          const edge = Math.max(0, Math.min(1, fall + tooth * fall));
          if (on && edge > 0.04) {
            data[i] = ink[0];
            data[i + 1] = ink[1];
            data[i + 2] = ink[2];
            data[i + 3] = Math.round(edge * 165);
          } else {
            data[i] = 0;
            data[i + 1] = 0;
            data[i + 2] = 0;
            data[i + 3] = 0;
          }
        } else {
          const c = on ? ink : paper;
          data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  const ditherCanvases = [...document.querySelectorAll('.dither-canvas')];
  const activeDithers = new Set();
  if (ditherCanvases.length && !reduced) {
    let last = 0;
    const tick = (now) => {
      if (now - last > 40) {
        last = now;
        const t = now * 0.001;
        activeDithers.forEach((c) => paintDither(c, c.dataset.dither || 'flow', t));
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          activeDithers.add(entry.target);
          paintDither(entry.target, entry.target.dataset.dither || 'flow', performance.now() * 0.001);
        } else activeDithers.delete(entry.target);
      });
    }, { threshold: 0.08 });
    ditherCanvases.forEach((c) => io.observe(c));
  } else {
    ditherCanvases.forEach((c) => paintDither(c, c.dataset.dither || 'flow', 0));
  }

  // Use-case tabs — only one panel visible (no GSAP opacity leaks)
  const useWindow = document.getElementById('use-window');
  if (useWindow) {
    const tabs = useWindow.querySelectorAll('.use-tab');
    const panels = useWindow.querySelectorAll('.use-panel');
    const showPanel = (id) => {
      tabs.forEach((t) => {
        const on = t.dataset.tab === id;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', String(on));
      });
      panels.forEach((p) => {
        const on = p.dataset.panel === id;
        p.classList.toggle('is-active', on);
        // clear any leftover GSAP inline styles from older builds
        p.style.opacity = '';
        p.style.transform = '';
        p.style.clipPath = '';
        p.style.visibility = '';
        p.style.pointerEvents = '';
      });
      const activeCanvas = useWindow.querySelector('.use-panel.is-active .dither-canvas');
      if (activeCanvas) {
        activeDithers.add(activeCanvas);
        paintDither(activeCanvas, activeCanvas.dataset.dither || 'flow', performance.now() * 0.001);
      }
    };
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => showPanel(tab.dataset.tab));
    });
    // ensure clean initial state
    const initial = useWindow.querySelector('.use-tab.active')?.dataset.tab
      || tabs[0]?.dataset.tab;
    if (initial) showPanel(initial);
  }

  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.getAttribute('data-copy') || '');
        const prev = btn.textContent;
        btn.textContent = 'Copied';
        btn.classList.add('is-copied');
        btn.setAttribute('aria-live', 'polite');
        setTimeout(() => {
          btn.textContent = prev;
          btn.classList.remove('is-copied');
        }, 1400);
      } catch (_) { /* */ }
    });
  });

  // Docs: click a code block to copy
  document.querySelectorAll('.docs-content pre, .docs-prose pre').forEach((pre) => {
    pre.setAttribute('tabindex', '0');
    pre.setAttribute('title', 'Click to copy');
    pre.classList.add('is-copyable');
    const copy = async () => {
      const text = pre.innerText || '';
      try {
        await navigator.clipboard.writeText(text);
        pre.classList.add('is-copied');
        setTimeout(() => pre.classList.remove('is-copied'), 1200);
      } catch (_) { /* */ }
    };
    pre.addEventListener('click', copy);
    pre.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        copy();
      }
    });
  });

  // Use-case tabs keyboard (arrow keys)
  const useTabs = document.querySelectorAll('#use-window .use-tab');
  useTabs.forEach((tab, i) => {
    tab.setAttribute('role', 'tab');
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const next = e.key === 'ArrowRight'
        ? useTabs[(i + 1) % useTabs.length]
        : useTabs[(i - 1 + useTabs.length) % useTabs.length];
      next?.focus();
      next?.click();
    });
  });

  const snippets = {
    CURL: `curl /api/v1/compress \\\n  -H "Authorization: Bearer $SC_LIVE_..." \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "supercompress-v1",\n    "input": "$(cat conversation.txt)",\n    "preserve": "meaning",\n    "target_reduction": 0.8\n  }'`,
    Python: `from supercompress import Supercompress\n\nclient = Supercompress()\nresult = client.compress(\n    model="supercompress-v1",\n    input=conversation,\n    preserve="meaning",\n    target_reduction=0.8,\n)`,
    TypeScript: `import { Supercompress } from "supercompress";\n\nconst client = new Supercompress();\nconst result = await client.compress({\n  model: "supercompress-v1",\n  input: conversation,\n  preserve: "meaning",\n  targetReduction: 0.8\n});`,
    REST: `POST /v1/compress HTTP/1.1\nHost: api\nAuthorization: Bearer $SC_LIVE_...\nContent-Type: application/json\n\n{\n  "model": "supercompress-v1",\n  "input": "...",\n  "preserve": "meaning"\n}`
  };
  const terminalPre = document.querySelector('.terminal-code code');
  document.querySelectorAll('.terminal-tabs button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.terminal-tabs button').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      if (!terminalPre) return;
      terminalPre.textContent = snippets[button.textContent.trim()] || snippets.CURL;
      if (hasGsap) gsap.fromTo(terminalPre, { opacity: 0.3, y: 8 }, { opacity: 1, y: 0, duration: .35, ease: 'power2.out' });
    });
  });

  // —— Orbit ——
  const orbitRunway = document.getElementById('orbit-runway');
  const orbitLogos = [...document.querySelectorAll('.orbit-logo')];
  const orbitCaption = document.getElementById('orbit-caption');
  const captions = [
    'Every coding agent. One compression layer.',
    'Agents orbit in — context gets dense.',
    'SuperCompress pulls them into one path.',
    'Then install once and keep shipping.'
  ];

  function placeOrbit(progress) {
    const stage = document.getElementById('orbit-stage');
    const core = document.querySelector('.orbit-core');
    const rings = document.querySelector('.orbit-rings');
    if (!stage) return;
    const size = Math.min(stage.clientWidth, stage.clientHeight) || 600;
    const n = orbitLogos.length || 1;
    // 0 → orbit, then pull in & vanish; SuperCompress takes emphasis
    const absorb = Math.min(1, Math.max(0, (progress - 0.08) / 0.78));
    const ease = absorb * absorb * (3 - 2 * absorb); // smoothstep

    orbitLogos.forEach((el, i) => {
      // stagger so they don't all vanish on the same frame
      const local = Math.min(1, Math.max(0, (ease - i * 0.035) / 0.78));
      const spin = (i / n) * Math.PI * 2 - progress * Math.PI * 1.15;
      const radius = size * (0.38 * (1 - local));
      const x = Math.cos(spin) * radius;
      const y = Math.sin(spin) * radius;
      const scale = Math.max(0.08, 1 - local * 0.94);
      const opacity = Math.max(0, 1 - local * 1.08);
      el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale})`;
      el.style.opacity = String(opacity);
      el.style.pointerEvents = opacity < 0.05 ? 'none' : '';
      el.style.visibility = opacity < 0.02 ? 'hidden' : 'visible';
    });

    if (core) {
      const emphasis = 0.88 + ease * 0.28; // grows as agents merge in
      core.style.transform = `translate(-50%, -50%) scale(${emphasis})`;
      core.style.opacity = String(0.55 + ease * 0.45);
      core.classList.toggle('is-emphasized', ease > 0.55);
    }
    if (rings) {
      rings.style.opacity = String(Math.max(0, 1 - ease * 1.15));
    }

    if (orbitCaption) {
      const idx = Math.min(captions.length - 1, Math.floor(progress * captions.length));
      if (orbitCaption.textContent !== captions[idx]) orbitCaption.textContent = captions[idx];
    }
  }
  if (orbitRunway && orbitLogos.length) placeOrbit(0);

  // —— Vision word scrub ——
  const runway = document.getElementById('vision-runway');
  const words = [...document.querySelectorAll('.vision-word')];
  const updateVision = (progress) => {
    words.forEach((w, i) => {
      const wordProgress = (progress * words.length - i) / 1.6;
      const o = Math.min(1, Math.max(0.28, wordProgress));
      w.style.opacity = String(o);
      if (hasGsap) w.style.transform = `translateY(${(1 - o) * 6}px)`;
    });
  };
  if (words.length) {
    if (reduced) words.forEach((w) => { w.style.opacity = '1'; });
    else updateVision(0);
  }

  if (hasGsap && !reduced) {
    gsap.registerPlugin(ScrollTrigger);
    gsap.config({ nullTargetWarn: false });

    // Hero title/copy: CSS-only (datafruit-style). Do not override with GSAP.

    // —— Scroll-locks ONLY: vision write-up + agent orbit (CSS sticky, no GSAP pin) ——
    const scrubProgress = (el) => {
      const rect = el.getBoundingClientRect();
      const total = Math.max(el.offsetHeight - window.innerHeight, 1);
      return Math.min(1, Math.max(0, -rect.top / total));
    };

    const syncVision = (progress) => {
      const n = words.length || 1;
      words.forEach((w, i) => {
        // ink-in across the sticky runway — readable when dim, solid when lit
        const start = (i / n) * 0.92;
        const end = start + 0.08;
        const t = (progress - start) / Math.max(end - start, 0.001);
        const o = Math.min(1, Math.max(0.28, t));
        w.style.opacity = String(o);
        w.style.filter = '';
        w.style.transform = '';
      });
    };

    if (runway && words.length) {
      // Drive from sticky runway progress (works even if ST start/end is flaky)
      const onVisionScroll = () => syncVision(scrubProgress(runway));
      window.addEventListener('scroll', onVisionScroll, { passive: true });
      ScrollTrigger.create({
        trigger: runway,
        start: 'top bottom',
        end: 'bottom top',
        onUpdate: onVisionScroll,
        onRefresh: onVisionScroll
      });
      onVisionScroll();
    }

    if (orbitRunway && orbitLogos.length) {
      const onOrbitScroll = () => placeOrbit(scrubProgress(orbitRunway));
      window.addEventListener('scroll', onOrbitScroll, { passive: true });
      ScrollTrigger.create({
        trigger: orbitRunway,
        start: 'top bottom',
        end: 'bottom top',
        onUpdate: onOrbitScroll,
        onRefresh: onOrbitScroll
      });
      // Core emphasis is driven by placeOrbit (agents vanish → SuperCompress dominates)
      gsap.to('.orbit-ring', {
        rotate: 120, ease: 'none',
        scrollTrigger: { trigger: orbitRunway, start: 'top top', end: 'bottom bottom', scrub: true }
      });
      onOrbitScroll();
    }

    // —— Pipeline scroll-lock ——
    const pipelineRunway = document.getElementById('pipeline-runway');
    const pipelineSteps = [...document.querySelectorAll('.pipeline-step')];
    const pipelineCaption = document.getElementById('pipeline-caption');
    const pipelineFill = document.getElementById('pipeline-meter-fill');
    const pipelineIn = document.getElementById('pipeline-tokens-in');
    const pipelineOut = document.getElementById('pipeline-tokens-out');
    const pipelineCaptions = [
      'Context arrives oversized — history, docs, and traces piled into one prompt.',
      'A small policy scores every block against the current user question.',
      'Only the high-signal lines stay. Meaning retention stays first-class.',
      'The model sees a tighter prompt: lower cost, lower latency, same job done.'
    ];
    const TOKENS_IN = 23014;
    const TOKENS_OUT = 4220;
    let lastPipelineIdx = -1;
    const fmtTok = (n) => Math.round(n).toLocaleString('en-US');
    const syncPipeline = (progress) => {
      const n = pipelineSteps.length || 1;
      const eased = progress * progress * (3 - 2 * progress);
      const active = Math.min(n - 1, Math.floor(progress * n * 0.999));
      pipelineSteps.forEach((step, i) => {
        step.classList.toggle('is-active', i === active);
        step.classList.toggle('is-done', i < active);
      });
      const kept = TOKENS_IN - (TOKENS_IN - TOKENS_OUT) * eased;
      const scale = kept / TOKENS_IN;
      if (pipelineFill) pipelineFill.style.transform = `scaleX(${Math.max(0.08, scale)})`;
      if (pipelineIn) pipelineIn.textContent = fmtTok(TOKENS_IN);
      if (pipelineOut) pipelineOut.textContent = fmtTok(kept);
      if (pipelineCaption && active !== lastPipelineIdx) {
        lastPipelineIdx = active;
        pipelineCaption.classList.add('is-swap');
        window.setTimeout(() => {
          pipelineCaption.textContent = pipelineCaptions[active];
          pipelineCaption.classList.remove('is-swap');
        }, 160);
      }
    };
    if (pipelineRunway && pipelineSteps.length) {
      const onPipelineScroll = () => syncPipeline(scrubProgress(pipelineRunway));
      window.addEventListener('scroll', onPipelineScroll, { passive: true });
      ScrollTrigger.create({
        trigger: pipelineRunway,
        start: 'top bottom',
        end: 'bottom top',
        onUpdate: onPipelineScroll,
        onRefresh: onPipelineScroll
      });
      onPipelineScroll();
    }

    // —— Section scroll animations (leaf nodes only — no nested double fades) ——
    const revealEls = [...document.querySelectorAll('.reveal, .reveal-card')]
      .filter((el) => !el.closest('.orbit-section, .vision-section, .pipeline-section'))
      .filter((el) => !el.matches('.feature-card, .metric, .code-sample, .metrics-card, .terminal-section, .install-setup, .benchmark-table'))
      .filter((el) => !el.querySelector('.reveal, .reveal-card'));
    revealEls.forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight * 0.92 && rect.bottom > 40) {
        gsap.set(el, { clearProps: 'opacity,transform' });
        return;
      }
      el.classList.add('is-pending');
      gsap.fromTo(el,
        { opacity: 0, y: 24 },
        {
          opacity: 1,
          y: 0,
          duration: 0.7,
          ease: 'power2.out',
          overwrite: 'auto',
          scrollTrigger: {
            trigger: el,
            start: 'top 90%',
            once: true,
            onEnter: () => el.classList.remove('is-pending'),
            onRefresh: (self) => {
              if (self.progress > 0 || self.isActive) {
                el.classList.remove('is-pending');
                gsap.set(el, { opacity: 1, y: 0 });
              }
            }
          }
        }
      );
    });

    // Stagger feature / metric cells once (skip if already handled as reveal leaf)
    const featureGrid = document.querySelector('.feature-grid');
    if (featureGrid) {
      const kids = featureGrid.querySelectorAll('.feature-card');
      gsap.from(kids, {
        opacity: 0,
        y: 20,
        duration: 0.6,
        stagger: 0.1,
        ease: 'power2.out',
        scrollTrigger: { trigger: featureGrid, start: 'top 88%', once: true }
      });
    }

    // Use-case window soft enter
    const useWindow = document.getElementById('use-window');
    if (useWindow) {
      gsap.from(useWindow, {
        opacity: 0,
        y: 18,
        duration: 0.7,
        ease: 'power2.out',
        scrollTrigger: { trigger: useWindow, start: 'top 88%', once: true }
      });
    }

    // —— Metrics count + bench bars ——
    const metrics = document.querySelector('.metrics-card');
    if (metrics) {
      gsap.from(metrics.querySelectorAll('.code-sample, .metric'), {
        opacity: 0,
        y: 18,
        duration: 0.55,
        stagger: 0.07,
        ease: 'power2.out',
        scrollTrigger: { trigger: metrics, start: 'top 88%', once: true }
      });
      ScrollTrigger.create({
        trigger: metrics,
        start: 'top 80%',
        once: true,
        onEnter: () => {
          document.querySelectorAll('.metric').forEach((m) => m.classList.add('is-lit'));
          document.querySelectorAll('.metrics-card [data-count]').forEach((el) => {
            const end = Number(el.dataset.count);
            const suffix = el.textContent.includes('+') ? '%+' : '%';
            const state = { value: 0 };
            gsap.to(state, {
              value: end, duration: 1.15, ease: 'power2.out',
              onUpdate: () => { el.textContent = `${Math.round(state.value)}${suffix}`; }
            });
          });
        }
      });
    }

    const benchTable = document.querySelector('.benchmark-table');
    if (benchTable) {
      const fills = benchTable.querySelectorAll('.bar > i');
      gsap.set(fills, { scaleX: 0.12, transformOrigin: 'left center' });
      ScrollTrigger.create({
        trigger: benchTable,
        start: 'top 85%',
        once: true,
        onEnter: () => {
          document.dispatchEvent(new Event('sc:paint-bench-bars'));
          gsap.to(fills, {
            scaleX: 1, duration: 0.85, stagger: 0.05, ease: 'power2.out'
          });
        }
      });
    }

    // Terminal soft lift
    const terminal = document.querySelector('.terminal-section');
    if (terminal) {
      gsap.from(terminal, {
        opacity: 0,
        y: 22,
        duration: 0.75,
        ease: 'power2.out',
        scrollTrigger: { trigger: terminal, start: 'top 88%', once: true }
      });
    }

    // Install setup
    const install = document.querySelector('.install-setup');
    if (install) {
      gsap.from(install, {
        opacity: 0,
        y: 20,
        duration: 0.7,
        ease: 'power2.out',
        scrollTrigger: { trigger: install, start: 'top 88%', once: true }
      });
    }

    requestAnimationFrame(() => {
      ScrollTrigger.refresh();
      if (runway) syncVision(scrubProgress(runway));
      if (orbitRunway) placeOrbit(scrubProgress(orbitRunway));
      if (pipelineRunway) syncPipeline(scrubProgress(pipelineRunway));
    });
    window.addEventListener('load', () => ScrollTrigger.refresh());

  } else {
    document.querySelectorAll('.reveal,.reveal-card,.reveal-section,.animate-hero-enter,.animate-hero-enter-word').forEach((el) => {
      el.style.opacity = 1;
      el.style.transform = 'none';
      el.style.filter = 'none';
      el.classList.remove('is-pending');
    });
    if (runway && words.length && !reduced) {
      const sync = () => {
        const rect = runway.getBoundingClientRect();
        const total = Math.max(runway.offsetHeight - window.innerHeight, 1);
        updateVision(Math.min(Math.max(-rect.top, 0), total) / total);
      };
      window.addEventListener('scroll', sync, { passive: true });
      sync();
    }
    if (orbitRunway && !reduced) {
      const syncOrbit = () => {
        const rect = orbitRunway.getBoundingClientRect();
        const total = Math.max(orbitRunway.offsetHeight - window.innerHeight, 1);
        placeOrbit(Math.min(Math.max(-rect.top, 0), total) / total);
      };
      window.addEventListener('scroll', syncOrbit, { passive: true });
      syncOrbit();
    }
    const pipelineRunwayFb = document.getElementById('pipeline-runway');
    const pipelineStepsFb = [...document.querySelectorAll('.pipeline-step')];
    if (pipelineRunwayFb && pipelineStepsFb.length && !reduced) {
      const caps = [
        'Context arrives oversized — history, docs, and traces piled into one prompt.',
        'A small policy scores every block against the current user question.',
        'Only the high-signal lines stay. Meaning retention stays first-class.',
        'The model sees a tighter prompt: lower cost, lower latency, same job done.'
      ];
      const fill = document.getElementById('pipeline-meter-fill');
      const outEl = document.getElementById('pipeline-tokens-out');
      const syncPipe = () => {
        const rect = pipelineRunwayFb.getBoundingClientRect();
        const total = Math.max(pipelineRunwayFb.offsetHeight - window.innerHeight, 1);
        const progress = Math.min(Math.max(-rect.top, 0), total) / total;
        const eased = progress * progress * (3 - 2 * progress);
        const active = Math.min(pipelineStepsFb.length - 1, Math.floor(progress * pipelineStepsFb.length * 0.999));
        pipelineStepsFb.forEach((step, i) => {
          step.classList.toggle('is-active', i === active);
          step.classList.toggle('is-done', i < active);
        });
        const kept = 23014 - (23014 - 4220) * eased;
        if (fill) fill.style.transform = `scaleX(${Math.max(0.08, kept / 23014)})`;
        if (outEl) outEl.textContent = Math.round(kept).toLocaleString('en-US');
        const cap = document.getElementById('pipeline-caption');
        if (cap) cap.textContent = caps[active];
      };
      window.addEventListener('scroll', syncPipe, { passive: true });
      syncPipe();
    }
  }

  document.querySelectorAll('.magnetic').forEach((el) => {
    el.addEventListener('mousemove', (event) => {
      const rect = el.getBoundingClientRect();
      el.style.transform = `translate(${(event.clientX - rect.left - rect.width / 2) * .05}px, ${(event.clientY - rect.top - rect.height / 2) * .07}px)`;
    });
    el.addEventListener('mouseleave', () => { el.style.transform = ''; });
  });

  // Soft pointer tilt on lift cards (subtle)
  if (!reduced) {
    document.querySelectorAll('.feature-card.is-lift').forEach((card) => {
      card.addEventListener('mousemove', (e) => {
        const r = card.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        card.style.transform = `translateY(-3px) rotateX(${(-y * 2.2).toFixed(2)}deg) rotateY(${(x * 2.6).toFixed(2)}deg)`;
      });
      card.addEventListener('mouseleave', () => { card.style.transform = ''; });
    });
  }

  // Ripple-ish press on primary buttons
  document.querySelectorAll('.button-primary').forEach((btn) => {
    btn.addEventListener('pointerdown', () => btn.classList.add('is-pressed'));
    ['pointerup', 'pointerleave', 'blur'].forEach((ev) => {
      btn.addEventListener(ev, () => btn.classList.remove('is-pressed'));
    });
  });

  // Install check cascade on view
  const checks = document.querySelector('.install-checks');
  if (checks && hasGsap && !reduced) {
    const items = checks.querySelectorAll('li');
    gsap.from(items, {
      opacity: 0,
      x: -8,
      duration: 0.4,
      stagger: 0.08,
      ease: 'power2.out',
      scrollTrigger: { trigger: checks, start: 'top 90%', once: true }
    });
  }

  // Benchmark table: Bayer-dithered bar fills
  const benchTablePaint = document.querySelector('.benchmark-table');
  if (benchTablePaint) {
    const BAYER4 = [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5]
    ];
    const paintBenchBars = () => {
      benchTablePaint.querySelectorAll('.bar > i').forEach((fill) => {
        const canvas = fill.querySelector('canvas');
        const bar = fill.closest('.bar');
        if (!canvas || !bar) return;
        const cssW = Math.max(1, Math.round(fill.clientWidth || bar.clientWidth * 0.5));
        const cssH = Math.max(1, Math.round(bar.clientHeight || 8));
        const cell = 2;
        const w = Math.max(1, Math.floor(cssW / cell));
        const h = Math.max(1, Math.floor(cssH / cell));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        const ctx = canvas.getContext('2d');
        const blue = bar.dataset.tone === 'blue';
        const [r, g, b] = blue ? [5, 102, 255] : [28, 28, 28];
        ctx.clearRect(0, 0, w, h);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const edge = w > 1 ? x / (w - 1) : 1;
            const density = 0.28 + edge * 0.62;
            const t = (BAYER4[y & 3][x & 3] + 0.5) / 16;
            if (t < density) {
              ctx.fillStyle = `rgb(${r},${g},${b})`;
              ctx.fillRect(x, y, 1, 1);
            }
          }
        }
      });
    };
    requestAnimationFrame(paintBenchBars);
    window.addEventListener('resize', paintBenchBars, { passive: true });
    document.addEventListener('sc:paint-bench-bars', paintBenchBars);
  }

  // Neural canvas
  const canvas = document.getElementById('neuralCanvas');
  if (canvas && !reduced) {
    const ctx = canvas.getContext('2d');
    let width = 0, height = 0, dpr = 1;
    const lines = Array.from({ length: 28 }, (_, i) => ({
      offset: (i / 27 - .5), speed: .00028 + Math.random() * .00018, phase: Math.random() * Math.PI * 2
    }));
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(devicePixelRatio || 1, 2);
      width = rect.width; height = rect.height;
      canvas.width = width * dpr; canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    new ResizeObserver(resize).observe(canvas);
    const draw = (time) => {
      ctx.clearRect(0, 0, width, height);
      const sx = width * .17, sy = height * .5;
      lines.forEach((line, i) => {
        const t = time * line.speed + line.phase;
        const endY = height * (.08 + .84 * (i / (lines.length - 1)));
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.bezierCurveTo(width * .38, sy + line.offset * 36 + Math.sin(t) * 6, width * .64, endY - line.offset * 12, width * .98, endY);
        const pulse = .5 + .5 * Math.sin(t * 1.4 + i * 0.2);
        ctx.strokeStyle = `rgba(120,170,255,${0.08 + (i % 4) * .025 + pulse * 0.05})`;
        ctx.lineWidth = .85;
        ctx.stroke();
      });
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }
})();
