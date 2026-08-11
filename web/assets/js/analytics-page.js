/**
 * /analytics page boot — Firebase auth + dither charts.
 */
(function () {
  "use strict";

  const DATA = window.SCAnalyticsData;
  const DK = window.DitherKitLite;
  // Same-origin in prod; point at live API when serving static HTML locally.
  const API_BASE =
    /^(localhost|127\.0\.0\.1)$/i.test(location.hostname) || location.protocol === "file:"
      ? "https://www.supercompress.dev"
      : "";
  const $ = (id) => document.getElementById(id);

  const washes = [
    ["wash-cut", { color: "brand", intensity: 0.88 }],
    ["wash-saved", { color: "brand", intensity: 0.62 }],
    ["wash-in", { color: "sky", intensity: 0.58 }],
    ["wash-req", { color: "sky", intensity: 0.55 }],
  ];

  function animateNumber(el, to, { suffix = "", compact = false, duration = 900 } = {}) {
    if (!el || !DK) {
      if (el) el.textContent = (compact ? String(Math.round(to)) : String(Math.round(to))) + suffix;
      return;
    }
    const t0 = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const frame = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const v = to * ease(p);
      el.textContent = (compact ? DK.formatCompact(v) : String(Math.round(v))) + suffix;
      if (p < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  function paint(series) {
    const pill = $("data-pill");
    if (pill) {
      pill.className = series.live ? "pill pill--live" : "pill pill--demo";
      pill.textContent = series.live ? "Live · your account" : "Demo · sign in for live";
    }

    if ($("kpi-cut-sub")) {
      $("kpi-cut-sub").textContent = `${DK.formatCompact(series.totalSaved)} saved · ${DK.formatCompact(series.totalIn)} in`;
    }
    if ($("kpi-req-sub")) {
      $("kpi-req-sub").textContent = `${series.activeDays} active day${series.activeDays === 1 ? "" : "s"}`;
    }
    if ($("chip-delta")) {
      $("chip-delta").textContent = series.deltaLabel;
    }

    animateNumber($("kpi-cut"), series.cut, { suffix: "%" });
    animateNumber($("kpi-saved"), series.totalSaved, { compact: true });
    animateNumber($("kpi-in"), series.totalIn, { compact: true });
    animateNumber($("kpi-req"), series.totalReq, { compact: true });

    for (const [id, opts] of washes) {
      const el = $(id);
      if (!el) continue;
      DK.renderDitherWash(el, opts);
      DK.startDitherWashLoop(el, opts);
    }

    const areaMax = Math.max(1, ...series.areaData.map((d) => d.y));
    const reqMax = Math.max(1, ...series.reqs.map((r) => r.value));
    const areaEl = $("area");
    const barsEl = $("bars");
    if (areaEl) DK.stopChartDitherLoop(areaEl);
    if (barsEl) DK.stopChartDitherLoop(barsEl);

    const areaOpts = {
      color: "brand",
      variant: "gradient",
      bloom: "aura",
      unit: "tokens",
      tooltipTitle: "Tokens saved",
      yMax: areaMax,
      empty: !series.areaData.some((d) => d.y > 0),
      emptyLabel: series.live ? "No daily savings yet" : "No data",
    };
    DK.animateChart((p) => {
      DK.renderAreaChart(areaEl, {
        ...areaOpts,
        data: series.areaData.map((d) => ({ x: d.x, y: d.y * p })),
        interactive: false,
      });
      if (p > 0.98) {
        DK.renderAreaChart(areaEl, {
          ...areaOpts,
          data: series.areaData,
          interactive: true,
        });
        DK.startChartDitherLoop(areaEl, {
          kind: "area",
          ...areaOpts,
          data: series.areaData,
          interactive: true,
        });
      }
    }, 1100);

    DK.animateChart((p) => {
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
        emptyLabel: series.live ? "No requests yet" : "No data",
      };
      DK.renderBarChart(barsEl, barOpts);
      if (done) {
        DK.startChartDitherLoop(barsEl, { kind: "bar", ...barOpts, progress: 1, interactive: true });
      }
    }, 1100);

    const esc = DATA.escapeHtml;
    const agentTotal = series.agents.reduce((s, a) => s + a.value, 0) || 1;
    if ($("agents")) {
      $("agents").innerHTML = series.agents.length
        ? series.agents
            .map((a, i) => {
              const pct = Math.round((a.value / agentTotal) * 100);
              return `<li class="rank-row">
                <span class="rank-idx">${i + 1}</span>
                <div class="rank-main">
                  <p class="rank-name">${esc(a.label)}</p>
                  <p class="rank-meta">${DK.formatCompact(a.value)} tokens saved</p>
                  <div class="rank-track"><span class="rank-fill" data-w="${pct}"></span></div>
                </div>
                <div class="rank-val">${pct}%<small>of savings</small></div>
              </li>`;
            })
            .join("")
        : `<li class="rank-row"><div class="rank-main"><p class="rank-name">No agent usage yet</p><p class="rank-meta">Install the coding agent plugin to attribute savings</p></div></li>`;
    }

    const keyTotal = series.keys.reduce((s, k) => s + k.value, 0) || 1;
    if ($("keys")) {
      $("keys").innerHTML = series.keys.length
        ? series.keys
            .map((k) => {
              const pct = Math.round((k.value / keyTotal) * 100);
              return `<li class="rank-row">
                <div class="rank-main">
                  <p class="rank-name"><span class="key-dot"></span>${esc(k.label)}</p>
                  <p class="rank-meta">${pct}% of monthly savings</p>
                  <div class="rank-track"><span class="rank-fill" data-w="${pct}"></span></div>
                </div>
                <div class="rank-val">${DK.formatCompact(k.value)}<small>tokens</small></div>
              </li>`;
            })
            .join("")
        : `<li class="rank-row"><div class="rank-main"><p class="rank-name">No key breakdown yet</p><p class="rank-meta">Usage will land here after compress calls</p></div></li>`;
    }

    requestAnimationFrame(() => {
      document.querySelectorAll(".rank-fill").forEach((el) => {
        el.style.width = `${el.getAttribute("data-w")}%`;
      });
    });
  }

  async function loadFirebaseConfig() {
    try {
      const res = await fetch(`${API_BASE}/api/firebase-config`, { cache: "no-store" });
      if (!res.ok) return null;
      const cfg = await res.json();
      if (cfg?.apiKey && cfg?.projectId && cfg?.authDomain) return cfg;
    } catch (_) {}
    return null;
  }

  async function fetchKeys(idToken) {
    const res = await fetch(`${API_BASE}/api/keys?fresh=1&_=${Date.now()}`, {
      headers: { Authorization: `Bearer ${idToken}` },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`keys ${res.status}`);
    return res.json();
  }

  function setAuthUi(user) {
    const note = $("auth-note");
    const btn = $("btn-signin");
    if (!note || !btn) return;
    if (user) {
      note.textContent = user.email || "Signed in";
      btn.textContent = "Sign out";
      btn.classList.remove("primary");
      btn.dataset.mode = "out";
    } else {
      note.textContent = "Sign in to load your real usage.";
      btn.textContent = "Sign in with Google";
      btn.classList.add("primary");
      btn.dataset.mode = "in";
    }
  }

  async function boot() {
    if (!DATA?.bundleToSeries || !DK?.animateChart) {
      console.error("Analytics deps missing — hard-refresh.");
      if ($("auth-note")) $("auth-note").textContent = "Charts failed to load — hard-refresh.";
      return;
    }

    paint(DATA.bundleToSeries(DATA.demoBundle()));

    const { initializeApp } = await import("https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js");
    const {
      getAuth,
      GoogleAuthProvider,
      signInWithPopup,
      onAuthStateChanged,
      signOut,
      setPersistence,
      browserLocalPersistence,
    } = await import("https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js");

    const cfg = await loadFirebaseConfig();
    if (!cfg) {
      if ($("auth-note")) $("auth-note").textContent = "Firebase config unavailable — showing demo data.";
      return;
    }

    const app = initializeApp(cfg);
    const auth = getAuth(app);
    await setPersistence(auth, browserLocalPersistence);
    const provider = new GoogleAuthProvider();

    if ($("btn-signin")) {
      $("btn-signin").onclick = async () => {
        try {
          if ($("btn-signin").dataset.mode === "out") {
            await signOut(auth);
            return;
          }
          await signInWithPopup(auth, provider);
        } catch (err) {
          console.error(err);
          if ($("auth-note")) $("auth-note").textContent = err?.message || "Sign-in failed";
        }
      };
    }

    onAuthStateChanged(auth, async (user) => {
      setAuthUi(user);
      if (!user) {
        paint(DATA.bundleToSeries(DATA.demoBundle()));
        return;
      }
      try {
        if ($("data-pill")) $("data-pill").textContent = "Live · loading…";
        const token = await user.getIdToken(true);
        const payload = await fetchKeys(token);
        paint(DATA.bundleToSeries(DATA.aggregateUsage(payload)));
      } catch (err) {
        console.error(err);
        if ($("auth-note")) $("auth-note").textContent = "Could not load usage — showing demo.";
        paint(DATA.bundleToSeries(DATA.demoBundle()));
      }
    });

    window.addEventListener("resize", () => {
      for (const [id, opts] of washes) {
        const el = $(id);
        if (el) DK.renderDitherWash(el, opts);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
