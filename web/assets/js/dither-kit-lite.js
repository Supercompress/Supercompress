/**
 * dither-kit-lite — vanilla canvas port of Tripwire dither-kit paint primitives
 * (https://www.tripwire.sh/dither-kit). Ordered Bayer dither fills that read on
 * light + dark surfaces. No React / Tailwind / d3 required.
 */
(function (global) {
  "use strict";

  const BAYER = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ].map((row) => row.map((v) => (v + 0.5) / 16));

  const CELL = 2;
  const MAX_COLS = 640;
  const MAX_ROWS = 320;
  const BORDER_ALPHA = 0.72;
  const OFF_TIER = 0.4;

  const PALETTE = {
    // SuperCompress brand blue (#0566ff) — no green; secondary blues for series
    brand: { fill: [5, 102, 255], line: [120, 170, 255] },
    blue: { fill: [5, 102, 255], line: [120, 170, 255] },
    sky: { fill: [94, 156, 255], line: [160, 200, 255] },
    // Alias kept so old "green" calls stay on-brand blue
    green: { fill: [5, 102, 255], line: [120, 170, 255] },
    purple: { fill: [110, 90, 210], line: [180, 165, 255] },
    pink: { fill: [220, 80, 160], line: [255, 170, 220] },
    orange: { fill: [230, 140, 40], line: [255, 195, 130] },
    red: { fill: [220, 70, 70], line: [255, 150, 140] },
    grey: { fill: [92, 92, 100], line: [140, 140, 150] },
  };

  const SERIES_COLORS = ["brand", "sky", "orange", "purple", "pink", "red"];

  function clamp01(t) {
    return t < 0 ? 0 : t > 1 ? 1 : t;
  }

  function rgb(seedRgb, k = 1, a = 1) {
    const [r, g, b] = seedRgb;
    return `rgba(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)},${a})`;
  }

  function seedOf(color) {
    return PALETTE[color] || PALETTE.grey;
  }

  function backingSize(width, height) {
    return {
      cols: Math.min(MAX_COLS, Math.max(8, Math.round(width / CELL))),
      rows: Math.min(MAX_ROWS, Math.max(8, Math.round(height / CELL))),
    };
  }

  function paintColumn(octx, x, top, floor, seed, opts) {
    const variant = opts.variant || "gradient";
    const intensity = opts.intensity || 0;
    const dim = opts.dim == null ? 1 : opts.dim;
    const stacked = !!opts.stacked;
    const sparse = opts.sparse || 0;
    const t = Math.round(top);
    const f = Math.round(floor);
    const depth = f - t;
    if (depth <= 0) {
      octx.fillStyle = rgb(seed.fill, 1, BORDER_ALPHA * dim);
      octx.fillRect(x, t, 1, 1);
      return;
    }
    const bias = (variant === "dotted" ? 0.12 : 0) + (stacked ? 0.2 : 0) - sparse;
    for (let y = t; y < f; y++) {
      let density = (y - t) / depth;
      if (stacked) density = 0.5 + 0.5 * density;
      if (variant === "hatched" && ((x + y) & 3) >= 2) continue;
      const lit =
        variant === "solid" ||
        density > BAYER[y & 3][x & 3] - 0.1 * intensity - bias;
      if (variant === "dotted" && !lit) continue;
      const k = (0.3 + density * 0.7) * (1 + 0.22 * intensity);
      const alpha = clamp01((lit ? k : k * OFF_TIER) * dim);
      octx.fillStyle = rgb(seed.fill, 1, alpha);
      octx.fillRect(x, y, 1, 1);
    }
    octx.fillStyle = rgb(seed.fill, 1, BORDER_ALPHA * dim);
    octx.fillRect(x, t, 1, 1);
    if (depth > 1) {
      octx.fillStyle = rgb(seed.fill, 1, BORDER_ALPHA * 0.5 * dim);
      octx.fillRect(x, t + 1, 1, 1);
    }
  }

  function ensureHost(el) {
    if (!el) return null;
    el.classList.add("dk-chart");
    let crisp = el.querySelector("canvas.dk-crisp");
    let bloom = el.querySelector("canvas.dk-bloom");
    if (!crisp) {
      el.innerHTML = "";
      bloom = document.createElement("canvas");
      bloom.className = "dk-bloom";
      crisp = document.createElement("canvas");
      crisp.className = "dk-crisp";
      el.appendChild(bloom);
      el.appendChild(crisp);
    }
    return { host: el, crisp, bloom };
  }

  function sizeCanvases(host, crisp, bloom) {
    const rect = host.getBoundingClientRect();
    // Hidden tabs report 0×0 — fall back to CSS height / sensible defaults.
    const cssHAttr = parseFloat(getComputedStyle(host).height) || 0;
    const cssW = Math.max(40, Math.round(rect.width || host.clientWidth || host.parentElement?.clientWidth || 640));
    const cssH = Math.max(
      40,
      Math.round(rect.height || host.clientHeight || cssHAttr || 220)
    );
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const c of [crisp, bloom]) {
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
      c.style.width = cssW + "px";
      c.style.height = cssH + "px";
      const ctx = c.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return { cssW, cssH };
  }

  function isDarkHost(host) {
    return !!(host && (host.classList.contains("dk-theme-dark") || host.closest?.(".dk-theme-dark")));
  }

  function ink(host, kind = "muted") {
    if (isDarkHost(host)) {
      return kind === "strong" ? "rgba(241,245,249,0.88)" : kind === "faint" ? "rgba(148,163,184,0.55)" : "rgba(203,213,225,0.72)";
    }
    return kind === "strong" ? "rgba(15,23,42,0.78)" : kind === "faint" ? "rgba(100,116,139,0.45)" : "rgba(71,85,105,0.7)";
  }

  function applyBloom(bloom, crisp, level, host) {
    if (!bloom || level === "off") {
      if (bloom) {
        bloom.style.opacity = "0";
        bloom.style.filter = "none";
        bloom.getContext("2d").clearRect(0, 0, bloom.width, bloom.height);
      }
      return;
    }
    const dark = isDarkHost(host);
    const preset =
      level === "high"
        ? { blur: 7, brightness: dark ? 1.55 : 1.3, opacity: dark ? 0.5 : 0.38, saturate: 1.55 }
        : level === "aura"
          ? { blur: dark ? 16 : 12, brightness: dark ? 2.1 : 1.45, opacity: dark ? 0.28 : 0.2, saturate: dark ? 2.2 : 1.7 }
          : { blur: 4, brightness: dark ? 1.4 : 1.22, opacity: dark ? 0.45 : 0.34, saturate: 1.4 };
    const bctx = bloom.getContext("2d");
    bctx.clearRect(0, 0, bloom.width, bloom.height);
    bctx.drawImage(crisp, 0, 0);
    bloom.style.filter = `blur(${preset.blur}px) brightness(${preset.brightness}) saturate(${preset.saturate})`;
    bloom.style.opacity = String(preset.opacity);
    // Dark wells: classic Tripwire glow. Light wells: softer blend so cards don't bleed.
    bloom.style.mixBlendMode = dark ? "plus-lighter" : "soft-light";
  }

  /** Area / line chart. data = [{x, y}, ...] or numbers. */
  function renderAreaChart(el, options = {}) {
    const pack = ensureHost(el);
    if (!pack) return;
    const { host, crisp, bloom } = pack;
    const { cssW, cssH } = sizeCanvases(host, crisp, bloom);
    const ctx = crisp.getContext("2d");
    ctx.clearRect(0, 0, cssW, cssH);

    const color = options.color || "blue";
    const seed = seedOf(color);
    const variant = options.variant || "gradient";
    const bloomLevel = options.bloom || "aura";
    const showAxes = options.axes !== false;
    const pad = options.pad || (showAxes ? { t: 18, r: 10, b: 24, l: 40 } : { t: 4, r: 2, b: 4, l: 2 });
    const plotW = Math.max(8, cssW - pad.l - pad.r);
    const plotH = Math.max(8, cssH - pad.t - pad.b);

    let rows = options.data || [];
    if (rows.length && typeof rows[0] === "number") {
      rows = rows.map((y, i) => ({ x: String(i + 1), y }));
    }
    if (!rows.length) {
      rows = Array.from({ length: 8 }, (_, i) => ({ x: "", y: 0 }));
      options.empty = true;
    }

    if (options.empty) {
      if (showAxes) {
        ctx.fillStyle = ink(host, "faint");
        ctx.font = "13px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(options.emptyLabel || "No daily data yet", cssW / 2, cssH / 2);
      }
      applyBloom(bloom, crisp, "off", host);
      return;
    }

    const values = rows.map((r) => Number(r.y) || 0);
    const max = Math.max(1, ...values);
    const { cols, rows: bRows } = backingSize(plotW, plotH);
    const off = document.createElement("canvas");
    off.width = cols;
    off.height = bRows;
    const octx = off.getContext("2d");

    const tops = values.map((v) => {
      const t = 1 - v / max;
      return Math.max(0, Math.min(bRows - 1, Math.round(t * (bRows - 1))));
    });

    for (let c = 0; c < cols; c++) {
      const t = cols === 1 ? 0 : c / (cols - 1);
      const idx = t * (tops.length - 1);
      const i0 = Math.floor(idx);
      const i1 = Math.min(tops.length - 1, i0 + 1);
      const f = idx - i0;
      const top = tops[i0] * (1 - f) + tops[i1] * f;
      paintColumn(octx, c, top, bRows, seed, {
        variant,
        dim: 1,
      });
    }

    // subtle baseline
    ctx.strokeStyle = ink(host, "faint");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t + plotH + 0.5);
    ctx.lineTo(pad.l + plotW, pad.t + plotH + 0.5);
    ctx.stroke();

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, pad.l, pad.t, plotW, plotH);

    // value line
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = pad.l + (values.length === 1 ? plotW / 2 : (i / (values.length - 1)) * plotW);
      const y = pad.t + (1 - v / max) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = rgb(seed.line, 1, 0.92);
    ctx.lineWidth = 1.75;
    ctx.stroke();

    // axes labels — kept inside the plot box so they never collide with card titles
    if (showAxes) {
      ctx.fillStyle = ink(host, "muted");
      ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "left";
      ctx.fillText(formatCompact(max), pad.l + 4, pad.t + 12);
      ctx.fillText("0", pad.l + 4, pad.t + plotH - 4);
      if (rows.length >= 2) {
        ctx.fillText(String(rows[0].x || ""), pad.l + 4, cssH - 8);
        ctx.textAlign = "right";
        ctx.fillText(String(rows[rows.length - 1].x || ""), pad.l + plotW - 4, cssH - 8);
      }
    }

    applyBloom(bloom, crisp, bloomLevel, host);
  }

  function normalizeBars(raw) {
    return (raw || []).map((d) => {
      if (typeof d === "number") return { label: "", value: d };
      return {
        label: d.label != null ? d.label : d.x != null ? String(d.x) : "",
        value: d.value != null ? d.value : d.y,
        color: d.color,
        variant: d.variant,
      };
    });
  }

  /** Horizontal / vertical bar chart. data = [{label, value}] or [{x, y}] */
  function renderBarChart(el, options = {}) {
    const pack = ensureHost(el);
    if (!pack) return;
    const { host, crisp, bloom } = pack;
    const { cssW, cssH } = sizeCanvases(host, crisp, bloom);
    const ctx = crisp.getContext("2d");
    ctx.clearRect(0, 0, cssW, cssH);

    const horizontal = options.orientation !== "vertical";
    const limit = options.maxBars || (horizontal ? 8 : 32);
    const data = normalizeBars(options.data).slice(0, limit);
    const pad = options.pad || {
      t: 14,
      r: 14,
      b: horizontal ? 14 : 26,
      l: horizontal ? 96 : 12,
    };
    const plotW = Math.max(8, cssW - pad.l - pad.r);
    const plotH = Math.max(8, cssH - pad.t - pad.b);
    const max = Math.max(1, ...data.map((d) => Number(d.value) || 0));
    const empty = !!options.empty || !data.some((d) => (Number(d.value) || 0) > 0);

    if (!data.length || empty) {
      ctx.fillStyle = ink(host, "faint");
      ctx.font = "13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(options.emptyLabel || "No data yet", cssW / 2, cssH / 2);
      applyBloom(bloom, crisp, "off", host);
      return;
    }

    const gap = horizontal ? 6 : Math.max(1, Math.min(4, plotW / data.length / 4));
    const slot = (horizontal ? plotH : plotW) / data.length;
    const barThick = Math.max(horizontal ? 8 : 3, slot - gap);
    const defaultColor = options.color || null;
    const defaultVariant = options.variant || (horizontal ? "gradient" : "hatched");

    data.forEach((d, i) => {
      const seed = seedOf(d.color || defaultColor || SERIES_COLORS[i % SERIES_COLORS.length]);
      const v = Number(d.value) || 0;
      const frac = v / max;
      if (horizontal) {
        const y = pad.t + i * slot + (slot - barThick) / 2;
        const w = Math.max(2, frac * plotW);
        const { cols, rows } = backingSize(w, barThick);
        const off = document.createElement("canvas");
        off.width = cols;
        off.height = rows;
        const octx = off.getContext("2d");
        for (let c = 0; c < cols; c++) {
          paintColumn(octx, c, 0, rows, seed, {
            variant: d.variant || defaultVariant,
            stacked: true,
            dim: empty ? 0.4 : 1,
          });
        }
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(off, pad.l, y, w, barThick);
        ctx.fillStyle = ink(host, "strong");
        ctx.font = "12px system-ui, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(truncate(d.label || "", 14), pad.l - 8, y + barThick / 2 + 4);
        ctx.textAlign = "left";
        ctx.fillStyle = ink(host, "muted");
        ctx.font = "11px ui-monospace, Menlo, monospace";
        ctx.fillText(empty ? "—" : formatCompact(v), pad.l + w + 6, y + barThick / 2 + 4);
      } else {
        const x = pad.l + i * slot + (slot - barThick) / 2;
        const h = Math.max(2, frac * plotH);
        const y = pad.t + plotH - h;
        const { cols, rows } = backingSize(barThick, h);
        const off = document.createElement("canvas");
        off.width = cols;
        off.height = rows;
        const octx = off.getContext("2d");
        for (let c = 0; c < cols; c++) {
          paintColumn(octx, c, 0, rows, seed, {
            variant: d.variant || defaultVariant,
            stacked: true,
            dim: empty ? 0.4 : 1,
          });
        }
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(off, x, y, barThick, h);
      }
    });

    if (!horizontal && data.length) {
      ctx.fillStyle = ink(host, "muted");
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(String(data[0].label || ""), pad.l + 2, cssH - 8);
      ctx.textAlign = "right";
      ctx.fillText(String(data[data.length - 1].label || ""), pad.l + plotW - 2, cssH - 8);
    }

    applyBloom(bloom, crisp, options.bloom || "aura", host);
  }

  /** Donut / pie. data = [{label, value, color?}] */
  function renderPieChart(el, options = {}) {
    const pack = ensureHost(el);
    if (!pack) return;
    const { host, crisp, bloom } = pack;
    const { cssW, cssH } = sizeCanvases(host, crisp, bloom);
    const ctx = crisp.getContext("2d");
    ctx.clearRect(0, 0, cssW, cssH);

    const data = options.data || [];
    const total = data.reduce((n, d) => n + (Number(d.value) || 0), 0) || 1;
    const cx = cssW * 0.38;
    const cy = cssH / 2;
    const R = Math.min(cssW, cssH) * 0.34;
    const r0 = R * (options.innerRadius == null ? 0.55 : options.innerRadius);
    let a = -Math.PI / 2;

    if (!data.length || options.empty) {
      ctx.fillStyle = ink(host, "faint");
      ctx.font = "13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(options.emptyLabel || "No agents yet", cssW / 2, cssH / 2);
      applyBloom(bloom, crisp, "off", host);
      return;
    }

    data.forEach((d, i) => {
      const span = ((Number(d.value) || 0) / total) * Math.PI * 2;
      const seed = seedOf(d.color || SERIES_COLORS[i % SERIES_COLORS.length]);
      // dithered ring via many short arcs
      const steps = Math.max(12, Math.round((span / (Math.PI * 2)) * 72));
      for (let s = 0; s < steps; s++) {
        const t0 = a + (span * s) / steps;
        const t1 = a + (span * (s + 1)) / steps;
        const mid = (t0 + t1) / 2;
        const dens = 0.35 + 0.55 * ((s / steps + i * 0.07) % 1);
        const lit = dens > BAYER[(s + i) & 3][s & 3];
        const alpha = clamp01((lit ? 0.9 : 0.32) * dens);
        ctx.beginPath();
        ctx.arc(cx, cy, R, t0, t1);
        ctx.arc(cx, cy, r0, t1, t0, true);
        ctx.closePath();
        ctx.fillStyle = rgb(seed.fill, 1, alpha);
        ctx.fill();
        // soft edge tick
        ctx.beginPath();
        ctx.arc(cx, cy, R, t0, t1);
        ctx.strokeStyle = rgb(seed.fill, 1, 0.6);
        ctx.lineWidth = 1;
        ctx.stroke();
        void mid;
      }
      a += span;
    });

    // hole label
    ctx.fillStyle = ink(host, "strong");
    ctx.font = "600 16px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(formatCompact(total), cx, cy - 2);
    ctx.fillStyle = ink(host, "muted");
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText("saved", cx, cy + 14);

    // legend
    ctx.textAlign = "left";
    ctx.font = "12px system-ui, sans-serif";
    data.slice(0, 6).forEach((d, i) => {
      const seed = seedOf(d.color || SERIES_COLORS[i % SERIES_COLORS.length]);
      const y = 22 + i * 24;
      const lx = cssW * 0.66;
      ctx.fillStyle = rgb(seed.fill, 1, 0.95);
      ctx.fillRect(lx, y - 8, 10, 10);
      ctx.fillStyle = ink(host, "strong");
      ctx.fillText(`${truncate(d.label || "", 12)}  ${formatCompact(d.value)}`, lx + 16, y);
    });

    applyBloom(bloom, crisp, options.bloom || "aura", host);
  }

  /** Tiny sparkline for stat cards — no axis labels (they collide with KPI titles). */
  function renderSparkline(el, values, options = {}) {
    if (!el) return;
    const data = (values || []).map(Number).filter((n) => Number.isFinite(n));
    const has = data.some((n) => n > 0);
    renderAreaChart(el, {
      data: has ? data : [0, 0, 0, 0],
      color: options.color || "brand",
      variant: "gradient",
      bloom: "off",
      axes: false,
      pad: { t: 4, r: 2, b: 4, l: 2 },
      empty: !has,
    });
  }

  function formatCompact(n) {
    const v = Number(n) || 0;
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + "M";
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + "k";
    return String(Math.round(v));
  }

  function truncate(s, n) {
    const t = String(s || "");
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  }

  const DitherKitLite = {
    PALETTE,
    SERIES_COLORS,
    renderAreaChart,
    renderBarChart,
    renderPieChart,
    renderSparkline,
    formatCompact,
    seedOf,
  };

  global.DitherKitLite = DitherKitLite;
})(typeof window !== "undefined" ? window : globalThis);
