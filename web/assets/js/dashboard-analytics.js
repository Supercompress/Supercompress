/**
 * Dashboard Analytics panel — live meter only (no demo flash).
 * Uses the signed-in dashboard session via getIdToken().
 */
(function () {
  "use strict";

  const DATA = () => window.SCAnalyticsData;
  const DK = () => window.DitherKitLite;
  const $ = (id) => document.getElementById(id);

  const washes = [
    ["an-wash-cut", { color: "brand", intensity: 0.88 }],
    ["an-wash-saved", { color: "brand", intensity: 0.62 }],
    ["an-wash-in", { color: "sky", intensity: 0.58 }],
    ["an-wash-req", { color: "sky", intensity: 0.55 }],
  ];

  let loadedOnce = false;
  let loading = false;
  let paintGen = 0;
  let paintedUid = null;
  const cancelFns = [];

  function setPill(mode, text) {
    const pill = $("an-data-pill");
    if (!pill) return;
    pill.className =
      mode === "live"
        ? "an-pill an-pill--live"
        : mode === "err"
          ? "an-pill an-pill--err"
          : "an-pill an-pill--load";
    pill.textContent = text;
  }

  function setLoading(on, message) {
    const el = $("an-loading");
    if (!el) return;
    el.classList.toggle("hidden", !on);
    if (message) el.textContent = message;
  }

  function cancelPaints() {
    while (cancelFns.length) {
      const fn = cancelFns.pop();
      try {
        fn();
      } catch (_) {}
    }
  }

  function animateNumber(el, to, { suffix = "", compact = false, duration = 900, gen = 0 } = {}) {
    const kit = DK();
    if (!el) return;
    const n = Number(to);
    const v = Number.isFinite(n) ? Math.max(0, n) : 0;
    const fmt = (x) => (compact && kit ? kit.formatCompact(x) : String(Math.round(x))) + suffix;
    if (!kit?.animateChart) {
      el.textContent = fmt(v);
      return;
    }
    const cancel = kit.animateChart((p) => {
      if (gen !== paintGen) return;
      el.textContent = fmt(v * p);
    }, duration);
    cancelFns.push(cancel);
  }

  function paint(series) {
    const kit = DK();
    const data = DATA();
    if (!kit || !data) return;
    const gen = ++paintGen;
    cancelPaints();

    setPill(series.live ? "live" : "err", series.live ? "Live · your account" : "Could not load live usage");

    if ($("an-kpi-cut-sub")) {
      $("an-kpi-cut-sub").textContent = `${kit.formatCompact(series.totalSaved)} saved · ${kit.formatCompact(series.totalIn)} in`;
    }
    if ($("an-kpi-req-sub")) {
      $("an-kpi-req-sub").textContent = `${series.activeDays} active day${series.activeDays === 1 ? "" : "s"}`;
    }
    if ($("an-chip-delta")) $("an-chip-delta").textContent = series.deltaLabel;

    animateNumber($("an-kpi-cut"), series.cut, { suffix: "%", gen });
    animateNumber($("an-kpi-saved"), series.totalSaved, { compact: true, gen });
    animateNumber($("an-kpi-in"), series.totalIn, { compact: true, gen });
    animateNumber($("an-kpi-req"), series.totalReq, { compact: true, gen });

    for (const [id, opts] of washes) {
      const el = $(id);
      if (!el) continue;
      kit.renderDitherWash(el, opts);
      kit.startDitherWashLoop(el, opts);
    }

    const areaMax = Math.max(1, ...series.areaData.map((d) => d.y));
    const reqMax = Math.max(1, ...series.reqs.map((r) => r.value));
    const areaEl = $("an-area");
    const barsEl = $("an-bars");
    if (areaEl) kit.stopChartDitherLoop(areaEl);
    if (barsEl) kit.stopChartDitherLoop(barsEl);

    const areaOpts = {
      color: "brand",
      variant: "gradient",
      bloom: "aura",
      unit: "tokens",
      tooltipTitle: "Tokens saved",
      yMax: areaMax,
      empty: !series.areaData.some((d) => d.y > 0),
      emptyLabel: "No daily savings yet",
    };
    cancelFns.push(
      kit.animateChart((p) => {
        if (gen !== paintGen) return;
        kit.renderAreaChart(areaEl, {
          ...areaOpts,
          data: series.areaData.map((d) => ({ x: d.x, y: d.y * p })),
          interactive: false,
        });
        if (p > 0.98) {
          kit.renderAreaChart(areaEl, {
            ...areaOpts,
            data: series.areaData,
            interactive: true,
          });
          kit.startChartDitherLoop(areaEl, {
            kind: "area",
            ...areaOpts,
            data: series.areaData,
            interactive: true,
          });
        }
      }, 1100)
    );

    cancelFns.push(
      kit.animateChart((p) => {
        if (gen !== paintGen) return;
        const done = p > 0.98;
        const barOpts = {
          data: series.reqs.map((r) => ({ label: r.label, value: r.value, full: r.full })),
          orientation: "vertical",
          color: "brand",
          variant: "gradient",
          bloom: "aura",
          maxBars: 30,
          progress: done ? 1 : p,
          yMax: reqMax,
          unit: "requests",
          tooltipTitle: "Requests",
          interactive: done,
          empty: !series.reqs.some((r) => r.value > 0),
          emptyLabel: "No requests yet",
        };
        kit.renderBarChart(barsEl, barOpts);
        if (done) {
          kit.startChartDitherLoop(barsEl, { kind: "bar", ...barOpts, progress: 1, interactive: true });
        }
      }, 1100)
    );

    const esc = data.escapeHtml;
    const agentTotal = series.agents.reduce((s, a) => s + a.value, 0) || 1;
    if ($("an-agents")) {
      $("an-agents").innerHTML = series.agents.length
        ? series.agents
            .map((a, i) => {
              const pct = Math.round((a.value / agentTotal) * 100);
              return `<li class="rank-row">
                <span class="rank-idx">${i + 1}</span>
                <div class="rank-main">
                  <p class="rank-name">${esc(a.label)}</p>
                  <p class="rank-meta">${kit.formatCompact(a.value)} tokens saved</p>
                  <div class="rank-track"><span class="rank-fill" data-w="${pct}"></span></div>
                </div>
                <div class="rank-val">${pct}%<small>of savings</small></div>
              </li>`;
            })
            .join("")
        : `<li class="rank-row"><div class="rank-main"><p class="rank-name">No agent usage yet</p><p class="rank-meta">Install the coding agent plugin to attribute savings</p></div></li>`;
    }

    const keyTotal = series.keys.reduce((s, k) => s + k.value, 0) || 1;
    if ($("an-keys")) {
      $("an-keys").innerHTML = series.keys.length
        ? series.keys
            .map((k) => {
              const pct = Math.round((k.value / keyTotal) * 100);
              return `<li class="rank-row">
                <div class="rank-main">
                  <p class="rank-name"><span class="key-dot"></span>${esc(k.label)}</p>
                  <p class="rank-meta">${pct}% of monthly savings</p>
                  <div class="rank-track"><span class="rank-fill" data-w="${pct}"></span></div>
                </div>
                <div class="rank-val">${kit.formatCompact(k.value)}<small>tokens</small></div>
              </li>`;
            })
            .join("")
        : `<li class="rank-row"><div class="rank-main"><p class="rank-name">No key breakdown yet</p><p class="rank-meta">Usage will land here after compress calls</p></div></li>`;
    }

    requestAnimationFrame(() => {
      document.querySelectorAll("#panel-analytics .rank-fill").forEach((el) => {
        el.style.width = `${el.getAttribute("data-w")}%`;
      });
    });

    loadedOnce = true;
  }

  async function fetchKeys(idToken, { fresh = false } = {}) {
    const q = fresh ? `/api/keys?fresh=1&_=${Date.now()}` : `/api/keys?_=${Date.now()}`;
    const res = await fetch(q, {
      headers: { Authorization: `Bearer ${idToken}` },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`keys ${res.status}`);
    return res.json();
  }

  function reset() {
    loadedOnce = false;
    paintedUid = null;
    cancelPaints();
  }

  async function show({ getIdToken, force = false } = {}) {
    const data = DATA();
    const kit = DK();
    if (!data?.bundleToSeries || !kit?.animateChart) {
      setPill("err", "Charts failed to load");
      setLoading(true, "Charts failed to load — hard-refresh the dashboard.");
      return;
    }
    if (loading) return;

    const uid = window.SCDashboardKeysCache?.uid?.() || "";
    if (paintedUid && uid && paintedUid !== uid) {
      reset();
    }

    const apply = (payload) => {
      paint(data.bundleToSeries(data.aggregateUsage(payload)));
      setLoading(false);
      loadedOnce = true;
      paintedUid = uid || paintedUid;
    };

    if (loadedOnce && !force) {
      const areaH = $("an-area")?.querySelector("canvas")?.getBoundingClientRect().height || 0;
      if (areaH >= 80) {
        for (const [id, opts] of washes) {
          const el = $(id);
          if (el) kit.renderDitherWash(el, opts);
        }
        return;
      }
    }

    const cached = !force ? window.SCDashboardKeysCache?.peek?.() : null;
    loading = true;
    if (!cached) {
      setLoading(true, "Loading your live usage…");
      setPill("load", "Live · loading…");
    }
    try {
      await new Promise((resolve) => {
        let n = 8;
        const tick = () => {
          const w = $("an-area")?.getBoundingClientRect().width || 0;
          if (w > 40 || n-- <= 0) return resolve();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      if (cached) {
        apply(cached);
        return;
      }
      const token = await getIdToken();
      if (!token) throw new Error("Not signed in");
      const payload = await fetchKeys(token, { fresh: !!force });
      window.SCDashboardKeysCache?.remember?.(payload);
      apply(payload);
    } catch (err) {
      console.error(err);
      setPill("err", "Load failed");
      setLoading(true, "Could not load live usage. Stay signed in and try Analytics again.");
    } finally {
      loading = false;
    }
  }

  window.addEventListener("resize", () => {
    const kit = DK();
    if (!kit || !loadedOnce) return;
    for (const [id, opts] of washes) {
      const el = $(id);
      if (el) kit.renderDitherWash(el, opts);
    }
  });

  window.SCDashboardAnalytics = { show, paint, reset };
})();
