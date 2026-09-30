/**
 * Compression Arena — SuperCompress vs Headroom (client UI).
 */
(function () {
  "use strict";

  const STORAGE_KEY = "sc_arena_breaks_v1";
  const API = "/api/arena/compare";
  const PRICE = 2.5;
  const MONTHLY_TURNS = 10000;

  const $ = (id) => document.getElementById(id);
  const DK = () => window.DitherKitLite;

  const PROOF_WASHES = [
    ["arena-wash-cut", { color: "brand", intensity: 0.88 }],
    ["arena-wash-pass", { color: "brand", intensity: 0.62 }],
    ["arena-wash-max", { color: "sky", intensity: 0.58 }],
  ];

  function paintWash(el, opts) {
    const kit = DK();
    if (!el || !kit?.renderDitherWash) return;
    kit.renderDitherWash(el, opts);
    if (typeof kit.startDitherWashLoop === "function") {
      kit.startDitherWashLoop(el, opts);
    }
  }

  function paintProofWashes() {
    for (const [id, opts] of PROOF_WASHES) {
      paintWash($(id), opts);
    }
    paintWash($("arena-hero-wash"), { color: "brand", intensity: 0.45 });
  }

  function paintRunKpis(sc) {
    const host = $("arena-run-kpis");
    if (!host || !sc) return;
    const cut = sc.removed_pct != null ? `${sc.removed_pct}%` : "—";
    const retained = sc.answer_retained ? "Pass" : "Fail";
    const quality = `${Math.round((sc.answer_quality || 0) * 100)}%`;
    const latency = sc.latency_ms != null ? `${sc.latency_ms}ms` : "—";
    host.innerHTML = `
      <article class="arena-run-kpi arena-run-kpi--cut">
        <div class="arena-kpi-wash" data-arena-wash="cut" aria-hidden="true"></div>
        <div class="arena-kpi-body">
          <span class="arena-run-kpi-l">Cut</span>
          <strong class="arena-run-kpi-n">${escapeHtml(cut)}</strong>
          <span class="arena-run-kpi-s">${Number(sc.tokens_in || 0).toLocaleString()} → ${Number(sc.tokens_out || 0).toLocaleString()} tokens</span>
        </div>
      </article>
      <article class="arena-run-kpi">
        <div class="arena-kpi-wash" data-arena-wash="ret" aria-hidden="true"></div>
        <div class="arena-kpi-body">
          <span class="arena-run-kpi-l">Retention</span>
          <strong class="arena-run-kpi-n">${escapeHtml(retained)}</strong>
          <span class="arena-run-kpi-s">answer quality ${escapeHtml(quality)}</span>
        </div>
      </article>
      <article class="arena-run-kpi">
        <div class="arena-kpi-wash" data-arena-wash="lat" aria-hidden="true"></div>
        <div class="arena-kpi-body">
          <span class="arena-run-kpi-l">Latency</span>
          <strong class="arena-run-kpi-n">${escapeHtml(latency)}</strong>
          <span class="arena-run-kpi-s">this run</span>
        </div>
      </article>
      <article class="arena-run-kpi">
        <div class="arena-kpi-wash" data-arena-wash="cost" aria-hidden="true"></div>
        <div class="arena-kpi-body">
          <span class="arena-run-kpi-l">Cost / success</span>
          <strong class="arena-run-kpi-n">${escapeHtml(fmtUsd(sc.cost_per_success_usd))}</strong>
          <span class="arena-run-kpi-s">illustrative @ $${PRICE}/M</span>
        </div>
      </article>`;
    host.hidden = false;
    const washOpts = {
      cut: { color: "brand", intensity: 0.88 },
      ret: { color: "brand", intensity: 0.62 },
      lat: { color: "sky", intensity: 0.55 },
      cost: { color: "sky", intensity: 0.5 },
    };
    host.querySelectorAll("[data-arena-wash]").forEach((el) => {
      paintWash(el, washOpts[el.getAttribute("data-arena-wash")] || washOpts.cut);
    });

    const well = $("arena-chart-well");
    if (well && DK()?.renderDitherWash) {
      well.hidden = false;
      paintWash(well, { color: "brand", intensity: 0.35 });
    }
  }

  const PRESETS = {
    coding: {
      label: "Coding agent",
      query: "Why did the deploy fail and what file should I fix first?",
      context: [
        "npm WARN deprecated inflight@1.0.6",
        ...Array.from({ length: 40 }, (_, i) => `npm notice item ${i}`),
        "Error: PaymentIntent pi_live_9x failed: card_declined",
        "    at chargeCustomer (billing/stripe.ts:214:11)",
        "    at processOrder (orders/checkout.ts:88:5)",
        "DEPLOY FAILED shard=us-east-1",
        ...Array.from({ length: 35 }, (_, i) => `DEBUG heartbeat ok ${i}`),
        "Hint: retry queue is healthy; payment path is not.",
      ].join("\n"),
    },
    incident: {
      label: "Incident report",
      query: "What happened in warehouse W-ORBIT?",
      context: [
        "INCIDENT: warehouse W-ORBIT shelf S-19 tipped at 03:14Z",
        "SKU pallet PLT-NEON-88 contains lithium cells LOT-QX441",
        "Action: lock aisle 19, page safety lead Amira Okonkwo",
        ...Array.from({ length: 48 }, (_, i) => `rfid_ping bay=${i} ok`),
      ].join("\n"),
    },
    rag: {
      label: "RAG dump",
      query: "What is the auth token TTL and where is it configured?",
      context: [
        "# Product handbook (excerpt)",
        ...Array.from({ length: 25 }, (_, i) => `Marketing blurb paragraph ${i}: lorem features pricing enterprise.`),
        "AUTH_TTL_SECONDS=900  # config/auth.yaml line 42",
        "Refresh tokens rotate every 30 days; access tokens expire in AUTH_TTL_SECONDS.",
        ...Array.from({ length: 30 }, (_, i) => `Unrelated FAQ ${i}: returns shipping warranty.`),
        "Do not confuse with SESSION_COOKIE_MAX_AGE=86400.",
      ].join("\n"),
    },
    logs: {
      label: "Logs / JSON",
      query: "Which request ids show the OOM kill?",
      context: JSON.stringify(
        {
          events: [
            ...Array.from({ length: 20 }, (_, i) => ({ type: "heartbeat", i, ok: true })),
            { type: "oom", request_id: "req_oom_77", signal: "SIGKILL", rss_mb: 8192 },
            ...Array.from({ length: 15 }, (_, i) => ({ type: "metric", cpu: i % 7 })),
            { type: "oom", request_id: "req_oom_91", signal: "SIGKILL", rss_mb: 7900 },
            ...Array.from({ length: 18 }, (_, i) => ({ type: "access", path: `/v1/items/${i}` })),
          ],
        },
        null,
        2
      ),
    },
  };

  const SEED_BREAKS = [
    {
      id: "seed-hr-oom",
      query: "Which request ids show the OOM kill?",
      note: "Seed (pre-v4): Headroom kept OOM ids; older SC checkpoint over-cut shell noise.",
      sc_removed: 96.5,
      hr_removed: 12.0,
      winner: "Headroom",
      at: "2026-08-18",
    },
    {
      id: "seed-hr-build",
      query: "What failed in the CI build log?",
      note: "Seed (pre-v4): Headroom retained FAIL lines; SC cut too aggressively on npm chrome.",
      sc_removed: 94.5,
      hr_removed: 28.0,
      winner: "Headroom",
      at: "2026-08-18",
    },
  ];

  function roughTokens(text) {
    const s = String(text || "");
    if (!s) return 0;
    return Math.max(1, Math.round(s.length / 4));
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function isLocalHost() {
    const h = window.location.hostname;
    return h === "localhost" || h === "127.0.0.1" || h.endsWith(".local");
  }

  function loadBreaks() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  function saveBreak(entry) {
    const list = loadBreaks();
    list.unshift(entry);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, 50)));
  }

  function renderBoard() {
    const el = $("arena-board-list");
    if (!el) return;
    const user = loadBreaks();
    const rows = [...user, ...SEED_BREAKS];
    if (!rows.length) {
      el.innerHTML = `<li><span class="meta">No comparisons yet.</span></li>`;
      return;
    }
    el.innerHTML = rows
      .slice(0, 20)
      .map(
        (r) => `<li>
        <span class="tag">${escapeHtml(r.winner || "Headroom")} beat SuperCompress</span>
        <span class="q">${escapeHtml(r.query || "—")}</span>
        <span class="meta">${escapeHtml(r.note || "")} · SC −${r.sc_removed ?? "?"}% · HR −${r.hr_removed ?? "?"}% · ${escapeHtml(r.at || "")}</span>
      </li>`
      )
      .join("");
  }

  function updateContextStats() {
    const el = $("arena-context-stats");
    if (!el) return;
    const ctx = ($("arena-context").value || "").trim();
    if (!ctx) {
      el.textContent = "";
      return;
    }
    const lines = ctx.split("\n").filter((l) => l.trim()).length;
    const tok = roughTokens(ctx);
    el.textContent = `~${tok.toLocaleString()} tokens · ${lines.toLocaleString()} lines · ${ctx.length.toLocaleString()} chars`;
  }

  function setPreset(key) {
    const p = PRESETS[key];
    if (!p) return;
    $("arena-context").value = p.context;
    $("arena-query").value = p.query;
    document.querySelectorAll(".arena-presets button").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.preset === key);
    });
    updateContextStats();
  }

  function fmtUsd(n) {
    if (n == null || Number.isNaN(n)) return "— (failed)";
    if (n < 0.0001) return `$${n.toFixed(6)}`;
    return `$${n.toFixed(4)}`;
  }

  function monthlySavings(tokensIn, tokensOutHr, tokensOutSc) {
    if (!tokensIn || tokensOutHr == null || tokensOutSc == null) return null;
    const hrCost = (tokensOutHr / 1e6) * PRICE * MONTHLY_TURNS;
    const scCost = (tokensOutSc / 1e6) * PRICE * MONTHLY_TURNS;
    return Math.max(0, hrCost - scCost);
  }

  function renderInsights(data) {
    const box = $("arena-insights");
    const cta = $("arena-cta-band");
    if (!box) return;
    const sc = data.supercompress;
    const hr = (data.comparators && data.comparators.headroom) || data.headroom;
    const hrOk = hr && hr.status !== "unavailable";

    let html = `<h3 class="arena-insights-title">What this run means</h3><div class="arena-insights-grid">`;

    const savedVsHr =
      hrOk && sc.answer_retained && hr.answer_retained
        ? Math.max(0, (hr.tokens_out - sc.tokens_out) / Math.max(hr.tokens_out, 1))
        : null;

    html += `<article class="arena-insight-card">
      <div class="arena-kpi-wash" data-arena-wash="i0" aria-hidden="true"></div>
      <div class="arena-kpi-body">
        <p class="arena-insight-kicker">Your prompt</p>
        <p class="arena-insight-val">${sc.tokens_in.toLocaleString()} → ${sc.tokens_out.toLocaleString()}</p>
        <p class="arena-insight-desc">SuperCompress removed <strong>${sc.removed_pct}%</strong> while answer retention is ${sc.answer_retained ? "✅" : "❌"}.</p>
      </div>
    </article>`;

    if (hrOk) {
      html += `<article class="arena-insight-card">
        <div class="arena-kpi-wash" data-arena-wash="i1" aria-hidden="true"></div>
        <div class="arena-kpi-body">
          <p class="arena-insight-kicker">vs Headroom</p>
          <p class="arena-insight-val">${savedVsHr != null ? `${Math.round(savedVsHr * 100)}% fewer` : "—"} tokens after</p>
          <p class="arena-insight-desc">Headroom: ${hr.tokens_in.toLocaleString()} → ${hr.tokens_out.toLocaleString()} (−${hr.removed_pct}%). Cost/success: ${fmtUsd(sc.cost_per_success_usd)} vs ${fmtUsd(hr.cost_per_success_usd)}.</p>
        </div>
      </article>`;

      const mo = monthlySavings(sc.tokens_in, hr.tokens_out, sc.tokens_out);
      if (mo != null && mo > 0.01) {
        html += `<article class="arena-insight-card highlight">
          <div class="arena-kpi-wash" data-arena-wash="i2" aria-hidden="true"></div>
          <div class="arena-kpi-body">
            <p class="arena-insight-kicker">Projected @ ${MONTHLY_TURNS.toLocaleString()} turns/mo</p>
            <p class="arena-insight-val">~$${mo.toFixed(0)}/mo</p>
            <p class="arena-insight-desc">Illustrative input savings vs Headroom at $${PRICE}/M tokens (same retention).</p>
          </div>
        </article>`;
      }
    } else {
      html += `<article class="arena-insight-card">
        <div class="arena-kpi-wash" data-arena-wash="i1" aria-hidden="true"></div>
        <div class="arena-kpi-body">
          <p class="arena-insight-kicker">Headroom column</p>
          <p class="arena-insight-val">Unavailable</p>
          <p class="arena-insight-desc">${escapeHtml(hr.hint || hr.error || "Run via hosted API for apples-to-apples.")}</p>
        </div>
      </article>`;
    }

    html += `</div>`;
    box.innerHTML = html;
    box.hidden = false;
    const insightWash = {
      i0: { color: "brand", intensity: 0.75 },
      i1: { color: "sky", intensity: 0.55 },
      i2: { color: "brand", intensity: 0.68 },
    };
    box.querySelectorAll("[data-arena-wash]").forEach((el) => {
      paintWash(el, insightWash[el.getAttribute("data-arena-wash")] || insightWash.i0);
    });

    if (cta) {
      const blurb = $("arena-cta-blurb");
      if (blurb) {
        if (data.broke_supercompress) {
          blurb.textContent =
            "Headroom won this round on this prompt — try SuperCompress in your agent loop anyway; MCP hooks compress before every model call.";
        } else if (savedVsHr != null && savedVsHr > 0.2) {
          blurb.textContent = `You just cut ${Math.round(savedVsHr * 100)}% more input than Headroom on the same question. Wire that into Cursor or your API pipeline.`;
        } else {
          blurb.textContent =
            "Compress bulky tool output before every model call — query-aware, extractive, no summarization drift.";
        }
      }
      cta.hidden = false;
    }
  }

  function renderEngineBadge(data) {
    const el = $("arena-engine-badge");
    if (!el) return;
    const sc = data.supercompress || {};
    const engine = sc.engine || data.engine || "";
    const mode = String(engine).toLowerCase();
    if (mode.includes("neural")) {
      el.textContent = "Engine: Neural Keep (v4-large cross-encoder)";
      el.hidden = false;
    } else if (engine) {
      el.textContent = `Engine: ${engine}`;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  function cellClass(mine, theirs, higherIsBetter) {
    if (mine == null || theirs == null) return "";
    if (mine === theirs) return "";
    const win = higherIsBetter ? mine > theirs : mine < theirs;
    return win ? "win" : "lose";
  }

  function comparatorSides(data) {
    // Ordered [id, side] pairs. New API: data.comparators. Legacy: data.headroom only.
    if (data.comparators && typeof data.comparators === "object") {
      return Object.entries(data.comparators);
    }
    if (data.headroom) return [["headroom", data.headroom]];
    return [];
  }

  function sideOk(side) {
    return side && side.status !== "unavailable";
  }

  function metricRows(sc, sides) {
    // Each row: [label, formatter, comparator(mine, best) → higherIsBetter | null]
    return [
      ["Original tokens", (s) => s.tokens_in, null],
      ["Tokens after", (s) => s.tokens_out, null],
      ["Removed", (s) => `${s.removed_pct}%`, "removed_pct:high"],
      ["Answer retained", (s) => (s.answer_retained ? "✅" : "❌"), "answer_retained"],
      ["Answer quality", (s) => `${Math.round((s.answer_quality || 0) * 100)}%`, "answer_quality:high"],
      ["Latency", (s) => `${s.latency_ms}ms`, "latency_ms:low"],
      ["Cost / successful task", (s) => fmtUsd(s.cost_per_success_usd), "cost_per_success_usd:low"],
    ];
  }

  function cellClassFor(rule, side, allSides) {
    if (!rule || !sideOk(side)) return "";
    if (rule === "answer_retained") return side.answer_retained ? "win" : "lose";
    const [key, dir] = rule.split(":");
    const mine = side[key];
    if (mine == null) return "";
    const others = allSides.filter((s) => s !== side && sideOk(s) && s[key] != null).map((s) => s[key]);
    if (!others.length) return "";
    const higher = dir === "high";
    const bestOther = higher ? Math.max(...others) : Math.min(...others);
    if (mine === bestOther) return "";
    const win = higher ? mine > bestOther : mine < bestOther;
    return win ? "win" : "lose";
  }

  function renderResults(data) {
    const box = $("arena-results");
    box.classList.add("is-open");
    const sc = data.supercompress;
    const pairs = comparatorSides(data);
    const hr = data.comparators?.headroom || data.headroom;
    const hrOk = sideOk(hr);

    const columns = [["supercompress", sc], ...pairs];
    const allSides = columns.map(([, s]) => s);
    const board = $("arena-scoreboard");
    board.style.setProperty(
      "--arena-board-cols",
      `1.15fr ${columns.map(() => "1fr").join(" ")}`
    );

    const heads = columns
      .map(([id, side]) => {
        const label = id === "supercompress" ? "SuperCompress" : side.name || id;
        return `<div class="col-head ${id === "supercompress" ? "sc" : ""}">${escapeHtml(label)}</div>`;
      })
      .join("");

    const bodyRows = metricRows(sc, allSides)
      .map(([label, fmt, rule]) => {
        const cells = columns
          .map(([, side]) => {
            if (!sideOk(side)) return `<div class="cell muted">—</div>`;
            const cls = cellClassFor(rule, side, allSides);
            return `<div class="cell ${cls}">${escapeHtml(String(fmt(side)))}</div>`;
          })
          .join("");
        return `<div class="cell muted">${escapeHtml(label)}</div>${cells}`;
      })
      .join("");

    board.innerHTML = `<div class="col-metric">Metric</div>${heads}${bodyRows}`;

    const win = data.winner || {};
    const banner = $("arena-winner");
    banner.classList.remove("is-break", "is-win");
    const anyComparatorOk = pairs.some(([, s]) => sideOk(s));
    if (!anyComparatorOk) {
      const firstErr = pairs.length ? pairs[0][1] : null;
      banner.innerHTML = `<strong>SuperCompress ran.</strong> Comparators unavailable on this host${firstErr && firstErr.hint ? ` — ${escapeHtml(firstErr.hint)}` : "."}`;
    } else if (data.broke_supercompress) {
      banner.classList.add("is-break");
      banner.innerHTML = `<strong>${escapeHtml(win.system || "A comparator")} wins this round</strong> on <code>${escapeHtml(win.reason || "cost/answer")}</code>. Share the comparison if you want.`;
      $("arena-break-btn").disabled = false;
    } else if (win.system === "SuperCompress") {
      banner.classList.add("is-win");
      banner.innerHTML = `<strong>SuperCompress wins</strong> on <code>${escapeHtml(win.reason || "cost_per_success")}</code>. Try another workload preset or paste your own dump.`;
      $("arena-break-btn").disabled = true;
    } else {
      banner.innerHTML = `<strong>Too close to call</strong> (${escapeHtml(win.reason || "tie")}). Push a harder case.`;
      $("arena-break-btn").disabled = false;
    }

    const previews = $("arena-previews");
    if (previews) {
      previews.innerHTML = columns
        .map(([id, side]) => {
          const label = id === "supercompress" ? "SuperCompress output" : `${side.name || id} output`;
          const content = sideOk(side)
            ? side.compressed_preview || ""
            : side.hint || side.error || "Unavailable on this host";
          return `<div class="arena-preview"><h3>${escapeHtml(label)}</h3><pre>${escapeHtml(content)}</pre></div>`;
        })
        .join("");
    }

    renderEngineBadge(data);
    paintRunKpis(sc);
    renderInsights(data);

    window.__arenaLast = data;
    $("arena-share-btn").disabled = false;
    $("arena-copy-btn").disabled = false;
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function runClientFallback(context, query) {
    const E = window.SuperCompressEngine;
    if (!E || typeof E.compressAdaptive !== "function") {
      throw new Error("Local SuperCompress engine not loaded");
    }
    const t0 = performance.now();
    const result = await Promise.resolve(E.compressAdaptive(context, query));
    const ms = Math.round(performance.now() - t0);
    const compressed = result.compressed_text || result.text || "";
    const tokens_in = roughTokens(context);
    const tokens_out = roughTokens(compressed);
    const removed_pct = tokens_in ? Math.round(((tokens_in - tokens_out) / tokens_in) * 1000) / 10 : 0;
    const quality = E.answerQualityScore(context, compressed, query);
    const ok = quality >= 0.85;
    const cost = ok ? (tokens_out / 1e6) * PRICE : null;
    return {
      arena: "supercompress-context-compression-arena",
      version: "v2-preview-client",
      methodology: {
        note: "Client fallback — Headroom requires /api/arena/compare",
        killer_metric: "cost_per_success_usd",
      },
      query,
      supercompress: {
        name: "SuperCompress",
        tokens_in,
        tokens_out,
        removed_pct,
        answer_retained: ok,
        answer_quality: quality,
        latency_ms: ms,
        cost_per_success_usd: cost,
        compressed_preview: compressed.slice(0, 4000),
        engine: result.policy_name || result.mode || "compiler",
      },
      headroom: {
        name: "Headroom",
        status: "unavailable",
        error: "API unreachable",
        hint: "Start the site API (vercel dev) or set HEADROOM_API_BASE for a live Headroom column.",
      },
      winner: { system: "SuperCompress", reason: "headroom_unavailable" },
      broke_supercompress: false,
    };
  }

  function selectedComparators() {
    const active = [...document.querySelectorAll(".arena-comparators button.is-active")]
      .map((b) => b.dataset.comparator)
      .filter(Boolean);
    return active.length ? active : ["headroom", "rtk", "truncation"];
  }

  async function runArena() {
    const context = ($("arena-context").value || "").trim();
    const query = ($("arena-query").value || "").trim();
    const status = $("arena-status");
    const btn = $("arena-run");
    if (!context) {
      status.textContent = "Paste context first.";
      return;
    }
    if (!query) {
      status.textContent = "Add a question — compression is query-aware.";
      return;
    }
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add("is-loading");
    const results = $("arena-results");
    if (results) results.classList.add("is-running");
    status.textContent = "Running SuperCompress vs the field…";
    try {
      let data;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90000);
      try {
        const res = await fetch(API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ context, query, compare: selectedComparators() }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const body = await res.json().catch(() => ({}));
        if (res.status === 429) {
          throw new Error(body.detail || "Rate limit — wait a minute and retry.");
        }
        if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`);
        data = body;
      } catch (err) {
        clearTimeout(timeout);
        const offline =
          err.name === "AbortError"
            ? "Request timed out (90s)"
            : err.message || "network error";
        status.textContent = `API offline (${offline}). Running SuperCompress locally…`;
        data = await runClientFallback(context, query);
      }
      if (!data || !data.supercompress) {
        throw new Error("Invalid arena response — try again.");
      }
      renderResults(data);
      const unavailable = comparatorSides(data)
        .filter(([, s]) => !sideOk(s))
        .map(([, s]) => s.name)
        .filter(Boolean);
      status.textContent = unavailable.length
        ? `Done — unavailable on this host: ${unavailable.join(", ")}.`
        : "Done. Killer metric: cost per successful task.";
    } catch (err) {
      status.textContent = err.message || "Run failed";
    } finally {
      btn.disabled = false;
      btn.classList.remove("is-loading");
      if (results) results.classList.remove("is-running");
    }
  }

  function drawShareCard(data, mode) {
    const canvas = $("arena-share-canvas");
    const ctx = canvas.getContext("2d");
    const W = 1080;
    const H = 1080;
    canvas.width = W;
    canvas.height = H;

    const sc = data.supercompress;
    const broke = mode === "break" || data.broke_supercompress;

    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, "#fbfbf8");
    g.addColorStop(1, "#eef2ff");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "rgba(5,102,255,0.08)";
    ctx.beginPath();
    ctx.arc(900, 180, 320, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#0566ff";
    ctx.font = "600 28px Geist, sans-serif";
    ctx.fillText(broke ? "HEADROOM WON THIS ROUND" : "COMPRESSION ARENA RESULT", 72, 120);

    ctx.fillStyle = "#141412";
    ctx.font = "500 64px Platypi, Georgia, serif";
    ctx.fillText(`${sc.tokens_in.toLocaleString()} → ${sc.tokens_out.toLocaleString()} tokens`, 72, 240);

    ctx.fillStyle = "#0566ff";
    ctx.font = "500 92px Platypi, Georgia, serif";
    ctx.fillText(`${sc.removed_pct}% smaller`, 72, 360);

    ctx.fillStyle = "#5c5c56";
    ctx.font = "400 32px Geist, sans-serif";
    ctx.fillText(broke ? "Headroom won this round" : "SuperCompress Neural v4", 72, 440);

    ctx.fillStyle = "#141412";
    ctx.font = "400 26px Geist, sans-serif";
    const q = (data.query || "").slice(0, 90);
    ctx.fillText(q + (data.query && data.query.length > 90 ? "…" : ""), 72, 520);

    if (data.headroom && data.headroom.status !== "unavailable") {
      const hr = data.headroom;
      ctx.fillStyle = "#5c5c56";
      ctx.font = "400 24px Geist Mono, monospace";
      ctx.fillText(
        `Headroom: ${hr.tokens_in} → ${hr.tokens_out} (−${hr.removed_pct}%) · retained ${hr.answer_retained ? "yes" : "no"}`,
        72,
        590
      );
      ctx.fillText(
        `Cost/success  SC ${fmtUsd(sc.cost_per_success_usd)}  ·  HR ${fmtUsd(hr.cost_per_success_usd)}`,
        72,
        640
      );
    }

    ctx.fillStyle = "#141412";
    ctx.font = "500 36px Platypi, Georgia, serif";
    ctx.fillText("SuperCompress", 72, 980);
    ctx.fillStyle = "#0566ff";
    ctx.font = "italic 36px Platypi, Georgia, serif";
    ctx.fillText(" Arena", 340, 980);

    ctx.fillStyle = "#5c5c56";
    ctx.font = "400 22px Geist, sans-serif";
    ctx.fillText("SuperCompress", 72, 1030);

    $("arena-card-wrap").classList.add("is-open");
    return canvas;
  }

  function downloadCard() {
    const data = window.__arenaLast;
    if (!data) {
      $("arena-status").textContent = "Run the arena first to generate a share card.";
      return;
    }
    drawShareCard(data, data.broke_supercompress ? "break" : "share");
    const canvas = $("arena-share-canvas");
    if (!canvas) return;
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = "supercompress-arena.png";
    a.click();
  }

  function tweetIntent(data, broke) {
    const sc = data.supercompress;
    const text = broke
      ? `Compression Arena — Headroom won this round\n\n${sc.tokens_in} → ${sc.tokens_out} tokens (−${sc.removed_pct}%)\n\nCompare your own context →`
      : `Compression Arena result\n\n${sc.tokens_in} → ${sc.tokens_out} tokens\n${sc.removed_pct}% smaller · answer retained ${sc.answer_retained ? "✅" : "❌"}\nSuperCompress\n\nTry the arena →`;
    const url = "https://www.supercompress.dev/arena";
    window.open(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
      "_blank",
      "noopener"
    );
  }

  function onShare() {
    const data = window.__arenaLast;
    if (!data) return;
    drawShareCard(data, "share");
    tweetIntent(data, false);
  }

  function onCopyJson() {
    const data = window.__arenaLast;
    if (!data || !navigator.clipboard) return;
    navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(() => {
      $("arena-status").textContent = "Copied JSON receipt to clipboard.";
    });
  }

  function onBreak() {
    const data = window.__arenaLast;
    if (!data) return;
    const sc = data.supercompress;
    const hr = (data.comparators && data.comparators.headroom) || data.headroom || {};
    saveBreak({
      id: `break-${Date.now()}`,
      query: data.query,
      note: data.broke_supercompress
        ? `Headroom won on ${data.winner && data.winner.reason}`
        : "Submitted as adversarial / close call",
      sc_removed: sc.removed_pct,
      hr_removed: hr.removed_pct,
      winner: "Headroom",
      at: new Date().toISOString().slice(0, 10),
    });
    renderBoard();
    drawShareCard(data, "break");
    tweetIntent(data, true);
    $("arena-status").textContent = "Saved to community comparisons.";
  }

  function init() {
    const banner = $("arena-local-banner");
    if (banner && isLocalHost()) {
      banner.hidden = false;
      banner.classList.remove("is-hidden");
    }

    paintProofWashes();
    // Re-paint after fonts/layout settle so washes fill the card bounds.
    requestAnimationFrame(() => paintProofWashes());
    window.addEventListener("resize", () => paintProofWashes(), { passive: true });

    renderBoard();
    document.querySelectorAll(".arena-presets button").forEach((btn) => {
      btn.addEventListener("click", () => setPreset(btn.dataset.preset));
    });
    $("arena-context").addEventListener("input", updateContextStats);
    $("arena-context").addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") runArena();
    });
    $("arena-query").addEventListener("keydown", (e) => {
      if (e.key === "Enter") runArena();
    });
    setPreset("coding");
    document.querySelectorAll(".arena-comparators button").forEach((btn) => {
      btn.addEventListener("click", () => btn.classList.toggle("is-active"));
    });
    $("arena-run").addEventListener("click", runArena);
    $("arena-share-btn").addEventListener("click", onShare);
    $("arena-copy-btn").addEventListener("click", onCopyJson);
    $("arena-break-btn").addEventListener("click", onBreak);
    $("arena-download-card").addEventListener("click", downloadCard);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
