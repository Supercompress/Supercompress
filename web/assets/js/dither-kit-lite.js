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
    const phase = Number(opts.phase) || 0;
    // Slow Bayer drift — keeps charts alive after the intro grow-in.
    const ox = Math.floor(phase * 2.4) & 3;
    const oy = Math.floor(phase * 1.3) & 3;
    const shimmer = 0.04 * Math.sin(phase * 1.7 + x * 0.11);
    for (let y = t; y < f; y++) {
      let density = (y - t) / depth;
      if (stacked) density = 0.5 + 0.5 * density;
      if (variant === "hatched" && ((x + y) & 3) >= 2) continue;
      const thresh = BAYER[(y + oy) & 3][(x + ox) & 3];
      const lit =
        variant === "solid" ||
        density > thresh - 0.1 * intensity - bias + shimmer;
      if (variant === "dotted" && !lit) continue;
      const k = (0.3 + density * 0.7) * (1 + 0.22 * intensity + shimmer * 0.5);
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
    // Hidden tabs report 0×0 — fall back to CSS height / min-height / sensible defaults.
    const cs = host ? getComputedStyle(host) : null;
    const cssHAttr = parseFloat(cs?.height) || parseFloat(cs?.minHeight) || 0;
    const cssW = Math.max(40, Math.round(rect.width || host.clientWidth || host.parentElement?.clientWidth || 640));
    const cssH = Math.max(
      120,
      Math.round(rect.height || host.clientHeight || cssHAttr || 260)
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
    const max = Math.max(1, options.yMax != null ? Number(options.yMax) : 0, ...values);
    const { cols, rows: bRows } = backingSize(plotW, plotH);
    const off = document.createElement("canvas");
    off.width = cols;
    off.height = bRows;
    const octx = off.getContext("2d");

    const tops = values.map((v) => {
      const t = 1 - v / max;
      return Math.max(0, Math.min(bRows - 1, Math.round(t * (bRows - 1))));
    });

    const phase = Number(options.phase) || 0;
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
        intensity: 0.12 + 0.08 * Math.sin(phase + c * 0.09),
        phase,
      });
    }
    host._dkLastPaint = { kind: "area", options: { ...options } };

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
    if (!options.live) {
      bindHover(host, {
        enabled: options.interactive !== false && !options.empty,
        title: options.tooltipTitle || "Value",
        unit: options.unit || "",
        points: values.map((v, i) => ({
          x: pad.l + (values.length === 1 ? plotW / 2 : (i / (values.length - 1)) * plotW),
          label: String(rows[i].x || ""),
          value: v,
        })),
        mode: "nearest-x",
      });
    }
  }

  function normalizeBars(raw) {
    return (raw || []).map((d) => {
      if (typeof d === "number") return { label: "", value: d };
      return {
        label: d.label != null ? d.label : d.x != null ? String(d.x) : "",
        value: d.value != null ? d.value : d.y,
        color: d.color,
        variant: d.variant,
        full: d.full,
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
    const progress = options.progress == null ? 1 : clamp01(Number(options.progress));
    const max = Math.max(1, options.yMax != null ? Number(options.yMax) : 0, ...data.map((d) => Number(d.value) || 0));
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
      const frac = (v / max) * progress;
      if (horizontal) {
        const y = pad.t + i * slot + (slot - barThick) / 2;
        const w = Math.max(2, frac * plotW);
        const { cols, rows } = backingSize(w, barThick);
        const off = document.createElement("canvas");
        off.width = cols;
        off.height = rows;
        const octx = off.getContext("2d");
        const phase = Number(options.phase) || 0;
        for (let c = 0; c < cols; c++) {
          paintColumn(octx, c, 0, rows, seed, {
            variant: d.variant || defaultVariant,
            stacked: true,
            dim: empty ? 0.4 : 1,
            intensity: 0.1 + 0.06 * Math.sin(phase + i * 0.4 + c * 0.08),
            phase: phase + i * 0.15,
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
        const phase = Number(options.phase) || 0;
        for (let c = 0; c < cols; c++) {
          paintColumn(octx, c, 0, rows, seed, {
            variant: d.variant || defaultVariant,
            stacked: true,
            dim: empty ? 0.4 : 1,
            intensity: 0.1 + 0.06 * Math.sin(phase + i * 0.35 + c * 0.08),
            phase: phase + i * 0.12,
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
    host._dkLastPaint = { kind: "bar", options: { ...options } };

    if (!horizontal && !options.live) {
      bindHover(host, {
        enabled: options.interactive !== false && !empty && progress > 0.95,
        title: options.tooltipTitle || "Value",
        unit: options.unit || "",
        points: data.map((d, i) => ({
          x: pad.l + i * slot + slot / 2,
          label: String(d.full || d.label || ""),
          value: Number(d.value) || 0,
        })),
        mode: "nearest-x",
      });
    }
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

  function ensureTip(host) {
    let tip = host.querySelector(".dk-tip");
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "dk-tip";
      tip.setAttribute("role", "tooltip");
      host.appendChild(tip);
    }
    if (getComputedStyle(host).position === "static") {
      host.style.position = "relative";
    }
    return tip;
  }

  function bindHover(host, cfg) {
    if (!host) return;
    if (host._dkHoverCleanup) {
      host._dkHoverCleanup();
      host._dkHoverCleanup = null;
    }
    if (!cfg || !cfg.enabled || !cfg.points || !cfg.points.length) {
      host.classList.remove("dk-hovering");
      const tip = host.querySelector(".dk-tip");
      if (tip) tip.style.opacity = "0";
      return;
    }

    const tip = ensureTip(host);
    const points = cfg.points;
    const unit = cfg.unit ? ` ${cfg.unit}` : "";

    const onMove = (ev) => {
      const rect = host.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < points.length; i++) {
        const d = Math.abs(points[i].x - x);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      const p = points[best];
      tip.innerHTML =
        `<strong>${cfg.title || "Value"}</strong>` +
        `<span>${p.label}</span>` +
        `<em>${formatCompact(p.value)}${unit}</em>`;
      tip.style.opacity = "1";
      const tw = tip.offsetWidth || 120;
      const th = tip.offsetHeight || 56;
      let left = p.x - tw / 2;
      left = Math.max(8, Math.min(rect.width - tw - 8, left));
      let top = 12;
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
      host.classList.add("dk-hovering");
    };

    const onLeave = () => {
      tip.style.opacity = "0";
      host.classList.remove("dk-hovering");
    };

    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    host._dkHoverCleanup = () => {
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
    };
  }

  /** Ease-out grow for charts. fn(progress 0→1) called each frame. Returns cancel(). */
  function animateChart(fn, duration = 900) {
    if (typeof fn !== "function") return () => {};
    let raf = 0;
    let stopped = false;
    const t0 = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const frame = (now) => {
      if (stopped) return;
      let p = (now - t0) / Math.max(1, duration);
      if (!Number.isFinite(p) || p < 0) p = 1;
      p = Math.min(1, p);
      fn(ease(p));
      if (p < 1) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
  }

  /** Horizontal Bayer usage meter (billing free-allowance bar). */
  function renderDitherMeter(el, options = {}) {
    if (!el) return false;
    el.querySelectorAll(".dash-billing-usage-fill").forEach((n) => n.remove());
    let canvas = el.querySelector("canvas.dk-meter");
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = "dk-meter";
      canvas.setAttribute("aria-hidden", "true");
      el.appendChild(canvas);
    }
    const rect = el.getBoundingClientRect();
    const cssW = Math.round(rect.width || el.clientWidth || 0);
    const cssH = Math.round(rect.height || el.clientHeight || 0);
    // Hidden panels are display:none → 0×0. Never fall back to a fake width.
    if (cssW < 16 || cssH < 4) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const pct = clamp01((Number(options.progress) || 0) / (options.max || 1));
    const colorName = options.color || (pct >= 0.9 ? "red" : pct >= 0.7 ? "orange" : "brand");
    const seed = seedOf(colorName);
    const cell = 4;
    const cols = Math.min(MAX_COLS, Math.max(8, Math.round(cssW / cell)));
    const rows = Math.min(MAX_ROWS, Math.max(4, Math.round(cssH / cell)));
    const off = document.createElement("canvas");
    off.width = cols;
    off.height = rows;
    const octx = off.getContext("2d");
    const fillCols = Math.round(cols * pct);
    octx.fillStyle = "rgba(15,23,42,0.08)";
    octx.fillRect(0, 0, cols, rows);
    for (let x = 0; x < fillCols; x++) {
      paintColumn(octx, x, 0, rows, seed, {
        variant: "dotted",
        intensity: 0.92,
        dim: 1,
      });
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, cssW, cssH);
    return true;
  }

  function ensureWashCanvas(el) {
    if (!el) return null;
    el.classList.add("dk-wash");
    let canvas = el.querySelector("canvas.dk-wash-canvas");
    if (!canvas) {
      el.innerHTML = "";
      canvas = document.createElement("canvas");
      canvas.className = "dk-wash-canvas";
      el.appendChild(canvas);
    }
    return canvas;
  }

  /** Soft Bayer field for KPI card backgrounds. */
  function renderDitherWash(el, options = {}) {
    const canvas = ensureWashCanvas(el);
    if (!canvas) return;
    const rect = el.getBoundingClientRect();
    const cssW = Math.max(40, Math.round(rect.width || el.clientWidth || 160));
    const cssH = Math.max(40, Math.round(rect.height || el.clientHeight || 120));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const seed = seedOf(options.color || "brand");
    const intensity = clamp01(options.intensity == null ? 0.5 : options.intensity);
    const phase = Number(options.phase) || 0;
    const { cols, rows } = backingSize(cssW, cssH);
    const off = document.createElement("canvas");
    off.width = cols;
    off.height = rows;
    const octx = off.getContext("2d");

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const nx = x / Math.max(1, cols - 1);
        const ny = y / Math.max(1, rows - 1);
        // soft corner bloom + slow phase drift
        const radial = 1 - Math.min(1, Math.hypot(nx - 0.15, ny - 0.2) * 1.15);
        const wave = 0.55 + 0.45 * Math.sin((nx + ny) * 4.2 + phase);
        const dens = clamp01(radial * wave * (0.35 + intensity * 0.75));
        const thresh = BAYER[y & 3][x & 3];
        if (dens <= thresh * 0.92) continue;
        const alpha = clamp01((dens - thresh * 0.5) * 0.55 * intensity);
        octx.fillStyle = rgb(seed.fill, 1, alpha);
        octx.fillRect(x, y, 1, 1);
      }
    }

    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 0.95;
    ctx.drawImage(off, 0, 0, cssW, cssH);
    ctx.globalAlpha = 1;
  }

  /** Continuous slow wash drift. Stores RAF handle on the element. */
  function startDitherWashLoop(el, options = {}) {
    if (!el) return;
    if (el._dkWashRaf) {
      cancelAnimationFrame(el._dkWashRaf);
      el._dkWashRaf = 0;
    }
    let phase = 0;
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(48, now - last);
      last = now;
      phase += dt * 0.0011;
      renderDitherWash(el, { ...options, phase });
      el._dkWashRaf = requestAnimationFrame(tick);
    };
    el._dkWashRaf = requestAnimationFrame(tick);
  }

  function stopDitherWashLoop(el) {
    if (!el || !el._dkWashRaf) return;
    cancelAnimationFrame(el._dkWashRaf);
    el._dkWashRaf = 0;
  }

  /** Continuous slow Bayer drift on a mounted chart (after intro animation). */
  function startChartDitherLoop(el, options = {}) {
    if (!el) return;
    stopChartDitherLoop(el);
    let phase = Number(options.phase) || 0;
    let last = performance.now();
    let acc = 0;
    const kind = options.kind || el._dkLastPaint?.kind || "area";
    const baseOpts = { ...(el._dkLastPaint?.options || {}), ...options };
    delete baseOpts.kind;
    const tick = (now) => {
      const dt = Math.min(48, now - last);
      last = now;
      acc += dt;
      phase += dt * 0.00085;
      // ~20fps dither shimmer — enough motion, lighter than every paint
      if (acc >= 50) {
        acc = 0;
        const opts = {
          ...baseOpts,
          phase,
          live: true,
          interactive: baseOpts.interactive !== false,
        };
        if (kind === "bar") renderBarChart(el, opts);
        else renderAreaChart(el, opts);
      }
      el._dkChartRaf = requestAnimationFrame(tick);
    };
    el._dkChartRaf = requestAnimationFrame(tick);
  }

  function stopChartDitherLoop(el) {
    if (!el || !el._dkChartRaf) return;
    cancelAnimationFrame(el._dkChartRaf);
    el._dkChartRaf = 0;
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
    renderDitherWash,
    startDitherWashLoop,
    stopDitherWashLoop,
    startChartDitherLoop,
    stopChartDitherLoop,
    animateChart,
    renderDitherMeter,
    formatCompact,
    seedOf,
  };

  global.DitherKitLite = DitherKitLite;
})(typeof window !== "undefined" ? window : globalThis);
