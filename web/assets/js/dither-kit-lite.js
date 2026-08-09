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
  const MAX_COLS = 520;
  const MAX_ROWS = 200;
  const BORDER_ALPHA = 0.72;
  const OFF_TIER = 0.4;

  const PALETTE = {
    green: { fill: [40, 210, 110], line: [150, 255, 180] },
    blue: { fill: [53, 143, 243], line: [150, 200, 255] },
    purple: { fill: [150, 110, 255], line: [200, 175, 255] },
    pink: { fill: [240, 90, 190], line: [255, 170, 220] },
    orange: { fill: [255, 150, 50], line: [255, 195, 130] },
    red: { fill: [240, 70, 70], line: [255, 150, 140] },
    grey: { fill: [92, 92, 100], line: [140, 140, 150] },
  };

  const SERIES_COLORS = ["blue", "green", "purple", "orange", "pink", "red"];

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
    const cssW = Math.max(1, host.clientWidth || 320);
    const cssH = Math.max(1, host.clientHeight || 180);
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

  function applyBloom(bloom, crisp, level) {
    if (!bloom || level === "off") {
      if (bloom) {
        bloom.style.opacity = "0";
        bloom.getContext("2d").clearRect(0, 0, bloom.width, bloom.height);
      }
      return;
    }
    const preset =
      level === "high"
        ? { blur: 5, brightness: 1.5, opacity: 0.55, saturate: 1.5 }
        : level === "aura"
          ? { blur: 14, brightness: 2.4, opacity: 0.14, saturate: 2.6 }
          : { blur: 3, brightness: 1.35, opacity: 0.55, saturate: 1.4 };
    const bctx = bloom.getContext("2d");
    bctx.clearRect(0, 0, bloom.width, bloom.height);
    bctx.drawImage(crisp, 0, 0);
    bloom.style.filter = `blur(${preset.blur}px) brightness(${preset.brightness}) saturate(${preset.saturate})`;
    bloom.style.opacity = String(preset.opacity);
    bloom.style.mixBlendMode = "plus-lighter";
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
    const pad = options.pad || { t: 12, r: 8, b: 22, l: 36 };
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
        variant: options.empty ? "dotted" : variant,
        dim: options.empty ? 0.45 : 1,
      });
    }

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, pad.l, pad.t, plotW, plotH);

    // value line
    if (!options.empty) {
      ctx.beginPath();
      values.forEach((v, i) => {
        const x = pad.l + (values.length === 1 ? plotW / 2 : (i / (values.length - 1)) * plotW);
        const y = pad.t + (1 - v / max) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = rgb(seed.line, 1, 0.85);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // axes labels
    ctx.fillStyle = "rgba(17,24,39,0.45)";
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "right";
    ctx.fillText(formatCompact(max), pad.l - 6, pad.t + 10);
    ctx.fillText("0", pad.l - 6, pad.t + plotH);
    if (rows.length >= 2) {
      ctx.textAlign = "left";
      ctx.fillText(String(rows[0].x || ""), pad.l, cssH - 6);
      ctx.textAlign = "right";
      ctx.fillText(String(rows[rows.length - 1].x || ""), pad.l + plotW, cssH - 6);
    }

    applyBloom(bloom, crisp, options.empty ? "off" : bloomLevel);
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
      t: 10,
      r: 12,
      b: horizontal ? 12 : 22,
      l: horizontal ? 88 : 28,
    };
    const plotW = Math.max(8, cssW - pad.l - pad.r);
    const plotH = Math.max(8, cssH - pad.t - pad.b);
    const max = Math.max(1, ...data.map((d) => Number(d.value) || 0));
    const empty = !!options.empty || !data.some((d) => (Number(d.value) || 0) > 0);

    if (!data.length) {
      ctx.fillStyle = "rgba(17,24,39,0.4)";
      ctx.font = "13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No data yet", cssW / 2, cssH / 2);
      applyBloom(bloom, crisp, "off");
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
      const frac = empty ? 0.08 : v / max;
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
        ctx.fillStyle = "rgba(17,24,39,0.7)";
        ctx.font = "12px system-ui, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(truncate(d.label || "", 14), pad.l - 8, y + barThick / 2 + 4);
        ctx.textAlign = "left";
        ctx.fillStyle = "rgba(17,24,39,0.45)";
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
      ctx.fillStyle = "rgba(17,24,39,0.4)";
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(String(data[0].label || ""), pad.l, cssH - 6);
      ctx.textAlign = "right";
      ctx.fillText(String(data[data.length - 1].label || ""), pad.l + plotW, cssH - 6);
    }

    applyBloom(bloom, crisp, empty ? "off" : options.bloom || "low");
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

    if (!data.length) {
      ctx.fillStyle = "rgba(17,24,39,0.4)";
      ctx.font = "13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No agents yet", cssW / 2, cssH / 2);
      applyBloom(bloom, crisp, "off");
      return;
    }

    data.forEach((d, i) => {
      const span = ((Number(d.value) || 0) / total) * Math.PI * 2;
      const seed = seedOf(d.color || SERIES_COLORS[i % SERIES_COLORS.length]);
      // dithered ring via many short arcs
      const steps = Math.max(12, Math.round((span / (Math.PI * 2)) * 64));
      for (let s = 0; s < steps; s++) {
        const t0 = a + (span * s) / steps;
        const t1 = a + (span * (s + 1)) / steps;
        const mid = (t0 + t1) / 2;
        const dens = 0.35 + 0.55 * ((s / steps + i * 0.07) % 1);
        const lit = dens > BAYER[(s + i) & 3][s & 3];
        const alpha = clamp01((lit ? 0.85 : 0.35) * dens);
        ctx.beginPath();
        ctx.arc(cx, cy, R, t0, t1);
        ctx.arc(cx, cy, r0, t1, t0, true);
        ctx.closePath();
        ctx.fillStyle = rgb(seed.fill, 1, alpha);
        ctx.fill();
        // soft edge tick
        ctx.beginPath();
        ctx.arc(cx, cy, R, t0, t1);
        ctx.strokeStyle = rgb(seed.fill, 1, 0.55);
        ctx.lineWidth = 1;
        ctx.stroke();
        void mid;
      }
      a += span;
    });

    // legend
    ctx.textAlign = "left";
    ctx.font = "12px system-ui, sans-serif";
    data.slice(0, 6).forEach((d, i) => {
      const seed = seedOf(d.color || SERIES_COLORS[i % SERIES_COLORS.length]);
      const y = 18 + i * 22;
      const lx = cssW * 0.68;
      ctx.fillStyle = rgb(seed.fill, 1, 0.9);
      ctx.fillRect(lx, y - 8, 10, 10);
      ctx.fillStyle = "rgba(17,24,39,0.75)";
      ctx.fillText(`${truncate(d.label || "", 12)}  ${formatCompact(d.value)}`, lx + 16, y);
    });

    applyBloom(bloom, crisp, options.bloom || "aura");
  }

  /** Tiny sparkline for stat cards. */
  function renderSparkline(el, values, options = {}) {
    if (!el) return;
    const data = (values || []).map(Number).filter((n) => Number.isFinite(n));
    renderAreaChart(el, {
      data: data.length ? data : [0, 0, 0, 0],
      color: options.color || "green",
      variant: "gradient",
      bloom: options.bloom || "low",
      pad: { t: 4, r: 2, b: 4, l: 2 },
      empty: !data.length,
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
