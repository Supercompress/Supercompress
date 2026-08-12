/**
 * Pure analytics aggregation for /analytics (and unit tests).
 * Browser: window.SCAnalyticsData
 * Node: module.exports
 */
(function (root) {
  "use strict";

  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

  function dayKeys(n = 30) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - i);
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  function labelDay(iso) {
    const d = new Date(iso + "T12:00:00");
    return {
      short: `${d.getMonth() + 1}/${d.getDate()}`,
      full: d.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
    };
  }

  function emptyDay() {
    return { tokens_saved: 0, tokens_in: 0, requests: 0 };
  }

  /** Ignore reconcile-* and other non-ISO day keys so charts stay honest. */
  function isChartDay(day) {
    return ISO_DAY.test(String(day || ""));
  }

  function sumAgents(codingAgentUsage) {
    let tokens_in = 0;
    let tokens_saved = 0;
    let tokens_out = 0;
    let requests = 0;
    for (const a of Object.values(codingAgentUsage || {})) {
      tokens_in += Number(a.tokens_in || 0);
      tokens_saved += Number(a.tokens_saved || 0);
      tokens_out += Number(a.tokens_out || 0);
      requests += Number(a.requests || 0);
    }
    return { tokens_in, tokens_saved, tokens_out, requests };
  }

  function sumKeys(usage) {
    let tokens_in = 0;
    let tokens_saved = 0;
    let tokens_out = 0;
    let requests = 0;
    for (const snap of Object.values(usage || {})) {
      tokens_in += Number(snap.total_tokens_in || 0);
      tokens_saved += Number(snap.total_tokens_saved || 0);
      tokens_out += Number(snap.total_tokens_out || 0);
      requests += Number(snap.total_requests || 0);
    }
    return { tokens_in, tokens_saved, tokens_out, requests };
  }

  /**
   * Build chart + KPI bundle from /api/keys payload (or demo shape).
   */
  function aggregateUsage(payload) {
    const keys = dayKeys(30);
    const byDay = Object.fromEntries(keys.map((k) => [k, emptyDay()]));
    const usage = payload.usage || {};
    const keyRows = [];

    for (const k of payload.keys || []) {
      const snap = usage[k.id] || {};
      keyRows.push({
        label: k.name || k.prefix || "Key",
        value: Number(snap.total_tokens_saved || 0),
      });
      for (const [day, rec] of Object.entries(snap.by_day || {})) {
        if (!isChartDay(day) || !byDay[day]) continue;
        byDay[day].tokens_saved += Number(rec.tokens_saved || 0);
        byDay[day].tokens_in += Number(rec.tokens_in || 0);
        byDay[day].requests += Number(rec.requests || 0);
      }
    }

    const agents = Object.entries(payload.coding_agent_usage || {})
      .map(([label, a]) => ({
        label,
        value: Number(a.tokens_saved || 0),
        color: "brand",
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);

    const daySaved = Object.values(byDay).reduce((s, d) => s + d.tokens_saved, 0);
    if (!agents.length && daySaved > 0) {
      agents.push({ label: "API / other", value: daySaved, color: "orange" });
    }

    const keyTotal = keyRows.reduce((s, k) => s + k.value, 0);
    const keysOut = keyTotal
      ? keyRows.sort((a, b) => b.value - a.value).slice(0, 8)
      : [];

    return {
      live: true,
      byDay,
      keys: keysOut,
      agents,
      account: payload.account_usage || null,
      keyTotals: sumKeys(usage),
      agentTotals: sumAgents(payload.coding_agent_usage),
    };
  }

  /** Realistic /api/keys shape for local Analytics debug (never used in prod). */
  function fakeKeysPayload() {
    const days = dayKeys(30);
    const mk = (i, scale) => {
      const d = new Date(days[i] + "T12:00:00");
      const weekend = d.getDay() === 0 || d.getDay() === 6 ? 0.32 : 1;
      const wave = 0.62 + 0.38 * Math.sin(i / 2.35);
      const ramp = 0.5 + (i / 29) * 0.75;
      const saved = Math.max(0, Math.round((38000 + i * 2600) * wave * ramp * weekend * scale));
      const tin = Math.round(saved / 0.53);
      const requests = Math.max(
        0,
        Math.round((16 + i * 1.15 + Math.sin(i / 1.65) * 9) * weekend * scale)
      );
      return { tokens_saved: saved, tokens_in: tin, requests };
    };

    const buckets = [
      ["fake_prod", 0.58],
      ["fake_stg", 0.17],
      ["fake_cursor", 0.25],
    ];
    const usage = {};
    const totals = { requests: 0, tokens_in: 0, tokens_saved: 0, tokens_out: 0 };
    for (const [id, scale] of buckets) {
      const byDay = {};
      let saved = 0;
      let tin = 0;
      let req = 0;
      days.forEach((iso, i) => {
        const rec = mk(i, scale);
        byDay[iso] = rec;
        saved += rec.tokens_saved;
        tin += rec.tokens_in;
        req += rec.requests;
      });
      usage[id] = {
        total_requests: req,
        total_tokens_in: tin,
        total_tokens_out: Math.max(0, tin - saved),
        total_tokens_saved: saved,
        by_day: byDay,
      };
      totals.requests += req;
      totals.tokens_in += tin;
      totals.tokens_saved += saved;
      totals.tokens_out += Math.max(0, tin - saved);
    }

    const month = new Date().toISOString().slice(0, 7);
    const cursorShare = 0.58;
    const codexShare = 0.24;
    const claudeShare = 0.18;
    return {
      _fake: true,
      keys: [
        { id: "fake_prod", name: "Production", prefix: "sc_live_prod", created_at: "2026-06-02T00:00:00.000Z" },
        { id: "fake_stg", name: "Staging", prefix: "sc_live_stg", created_at: "2026-07-11T00:00:00.000Z" },
        { id: "fake_cursor", name: "Cursor plugin", prefix: "sc_live_cur", created_at: "2026-07-28T00:00:00.000Z" },
      ],
      usage,
      account_usage: { month, ...totals },
      coding_agent_usage: {
        Cursor: {
          requests: Math.round(totals.requests * cursorShare),
          tokens_in: Math.round(totals.tokens_in * cursorShare),
          tokens_saved: Math.round(totals.tokens_saved * cursorShare),
          tokens_out: Math.round(totals.tokens_out * cursorShare),
        },
        Codex: {
          requests: Math.round(totals.requests * codexShare),
          tokens_in: Math.round(totals.tokens_in * codexShare),
          tokens_saved: Math.round(totals.tokens_saved * codexShare),
          tokens_out: Math.round(totals.tokens_out * codexShare),
        },
        "Claude Code": {
          requests: Math.round(totals.requests * claudeShare),
          tokens_in: Math.round(totals.tokens_in * claudeShare),
          tokens_saved: Math.round(totals.tokens_saved * claudeShare),
          tokens_out: Math.round(totals.tokens_out * claudeShare),
        },
      },
      agent_plugin: { linked: true },
    };
  }

  function demoBundle() {
    const keys = dayKeys(30);
    const byDay = {};
    keys.forEach((iso, i) => {
      const base = 18000 + Math.sin(i / 2.2) * 7000 + i * 1400;
      const spike = i > 22 ? 1.55 : i > 14 ? 1.2 : 1;
      const saved = Math.max(0, Math.round(base * spike));
      const tin = Math.round(saved / 0.55);
      byDay[iso] = {
        tokens_saved: saved,
        tokens_in: tin,
        requests: Math.max(
          0,
          Math.round(28 + Math.sin(i / 1.8) * 16 + i * 1.35 + (i > 22 ? 18 : 0))
        ),
      };
    });
    return {
      live: false,
      byDay,
      keys: [
        { label: "Production", value: 0.71 },
        { label: "Coding Agent", value: 0.22 },
        { label: "Dev", value: 0.07 },
      ],
      agents: [
        { label: "Cursor", value: 0.62, color: "brand" },
        { label: "Codex", value: 0.22, color: "sky" },
        { label: "API / other", value: 0.16, color: "orange" },
      ],
      account: null,
      keyTotals: null,
      agentTotals: null,
    };
  }

  function meterFromBundle(bundle) {
    const keys = dayKeys(30);
    let daySaved = 0;
    let dayIn = 0;
    let dayReq = 0;
    for (const iso of keys) {
      const d = bundle.byDay[iso] || emptyDay();
      daySaved += d.tokens_saved;
      dayIn += d.tokens_in;
      dayReq += d.requests;
    }

    const acct = bundle.account || {};
    const keyT = bundle.keyTotals || {};
    const agentT = bundle.agentTotals || {};

    const saved = Math.max(
      daySaved,
      Number(acct.tokens_saved || 0),
      Number(keyT.tokens_saved || 0),
      Number(agentT.tokens_saved || 0)
    );
    const tin = Math.max(
      dayIn,
      Number(acct.tokens_in || 0),
      Number(keyT.tokens_in || 0),
      Number(agentT.tokens_in || 0)
    );
    const req = Math.max(
      dayReq,
      Number(acct.requests || 0),
      Number(keyT.requests || 0),
      Number(agentT.requests || 0)
    );

    // Month meter ahead of ISO by_day (common when ledger/agent totals exist but
    // daily rows lagged). Spread the gap across days in the current calendar
    // month (within the 30-day window) so charts aren't a single today-spike.
    const gapSaved = Math.max(0, saved - daySaved);
    const gapIn = Math.max(0, tin - dayIn);
    const gapReq = Math.max(0, req - dayReq);
    if (gapSaved > 500 || gapIn > 500 || gapReq > 0) {
      distributeMeterGap(bundle.byDay, keys, gapSaved, gapIn, gapReq);
      daySaved = saved;
      dayIn = tin;
      dayReq = req;
    }

    return { saved, tin, req, daySaved, dayIn, dayReq, gapFolded: gapSaved > 500 || gapIn > 500 || gapReq > 0 };
  }

  /**
   * Spread unattributed month-meter gap across days in the current month.
   * Prefers days that already have activity; otherwise every day in-month.
   */
  function distributeMeterGap(byDay, keys, gapSaved, gapIn, gapReq) {
    const monthPrefix = new Date().toISOString().slice(0, 7);
    const monthDays = keys.filter((iso) => String(iso).startsWith(monthPrefix));
    const pool = monthDays.length ? monthDays : keys.slice();
    const active = pool.filter((iso) => {
      const d = byDay[iso] || emptyDay();
      return d.tokens_saved > 0 || d.tokens_in > 0 || d.requests > 0;
    });
    // If we only have 0–1 real days, fill the whole month strip so the chart
    // reads as a month — not one lonely spike + empty axis.
    const days = active.length >= 2 ? active : pool;
    const n = Math.max(1, days.length);
    let remS = gapSaved;
    let remI = gapIn;
    let remR = gapReq;
    const baseS = Math.floor(gapSaved / n);
    const baseI = Math.floor(gapIn / n);
    const baseR = Math.floor(gapReq / n);
    days.forEach((iso, i) => {
      const last = i === days.length - 1;
      const addS = last ? remS : baseS;
      const addI = last ? remI : baseI;
      const addR = last ? remR : baseR;
      remS -= addS;
      remI -= addI;
      remR -= addR;
      const cur = byDay[iso] || emptyDay();
      byDay[iso] = {
        tokens_saved: cur.tokens_saved + addS,
        tokens_in: cur.tokens_in + addI,
        requests: cur.requests + addR,
      };
    });
  }

  function bundleToSeries(bundle) {
    const keys = dayKeys(30);
    const meter = meterFromBundle(bundle);
    const areaData = keys.map((iso) => {
      const L = labelDay(iso);
      return { x: L.full, y: bundle.byDay[iso]?.tokens_saved || 0, iso };
    });
    const reqs = keys.map((iso) => {
      const L = labelDay(iso);
      return {
        label: L.short,
        full: L.full,
        value: bundle.byDay[iso]?.requests || 0,
      };
    });

    const saved = meter.saved;
    const tin = meter.tin;
    const cut = tin > 0 ? Math.round((saved / tin) * 100) : 0;
    const half = Math.floor(keys.length / 2);
    const first = areaData.slice(0, half).reduce((s, d) => s + d.y, 0);
    const second = areaData.slice(half).reduce((s, d) => s + d.y, 0);
    let deltaLabel = "—";
    if (first > 0) {
      const pct = Math.round(((second - first) / first) * 100);
      deltaLabel = `${pct >= 0 ? "+" : ""}${pct}% vs prior`;
    } else if (second > 0) {
      deltaLabel = "new activity";
    }

    const agents = (bundle.agents || []).map((a) =>
      typeof a.value === "number" && a.value <= 1 && saved
        ? { ...a, value: Math.round(saved * a.value) }
        : a
    );
    const keyRows = (bundle.keys || []).map((k) =>
      typeof k.value === "number" && k.value <= 1 && saved
        ? { ...k, value: Math.round(saved * k.value) }
        : k
    );

    return {
      live: !!bundle.live,
      areaData,
      reqs,
      totalSaved: saved,
      totalIn: tin,
      totalReq: meter.req,
      cut,
      activeDays: reqs.filter((r) => r.value > 0).length,
      deltaLabel,
      agents,
      keys: keyRows,
      synthesizedDay: meter.daySaved === 0 && saved > 0,
    };
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** Map coding-agent label → logo under /assets/logos/ (null = no logo). */
  function agentLogoSrc(name) {
    const key = String(name || "")
      .toLowerCase()
      .replace(/_/g, "-")
      .replace(/\s+/g, "-");
    const map = {
      cursor: "/assets/logos/cursor.svg",
      "claude-code": "/assets/logos/claude.png",
      claude: "/assets/logos/claude.png",
      anthropic: "/assets/logos/anthropic.svg",
      codex: "/assets/logos/codex.png",
      "openai-client": "/assets/logos/openai.png",
      openai: "/assets/logos/openai.png",
      copilot: "/assets/logos/copilot.png",
      "github-copilot": "/assets/logos/copilot.png",
      windsurf: "/assets/logos/windsurf.png",
      opencode: "/assets/logos/opencode.png",
      gemini: "/assets/logos/gemini.png",
      "google-gemini": "/assets/logos/gemini.png",
      vscode: "/assets/logos/vscode.png",
      "vs-code": "/assets/logos/vscode.png",
    };
    return map[key] || null;
  }

  function agentLogoHtml(name, { size = 18 } = {}) {
    const src = agentLogoSrc(name);
    if (!src) return "";
    const alt = escapeHtml(String(name || "agent"));
    return `<img class="sc-agent-logo" src="${src}" alt="${alt}" width="${size}" height="${size}" loading="lazy" decoding="async" />`;
  }

  const api = {
    dayKeys,
    labelDay,
    isChartDay,
    aggregateUsage,
    fakeKeysPayload,
    demoBundle,
    bundleToSeries,
    escapeHtml,
    sumAgents,
    sumKeys,
    distributeMeterGap,
    agentLogoSrc,
    agentLogoHtml,
  };

  root.SCAnalyticsData = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
