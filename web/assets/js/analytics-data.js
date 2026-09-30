/**
 * Pure analytics aggregation for /analytics (and unit tests).
 * Browser: window.SCAnalyticsData
 * Node: module.exports
 */
(function (root) {
  "use strict";

  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

  function utcYmd(d = new Date()) {
    return d.toISOString().slice(0, 10);
  }

  function dayKeys(n = 30) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date();
      d.setUTCHours(12, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - i);
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  function daysInMonth(month) {
    const [y, m] = String(month || "").split("-").map(Number);
    if (!y || !m) return 31;
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  /** Calendar days for the billing month through today (UTC), plus any earlier ISO days in `extra`. */
  function monthKeys(month, throughIso, extra = []) {
    const today = utcYmd();
    const m = String(month || today.slice(0, 7));
    const through = String(throughIso || today);
    const end =
      through.slice(0, 7) === m ? Math.max(1, Number(through.slice(8, 10)) || 1) : daysInMonth(m);
    const out = [];
    for (let i = 1; i <= end; i++) out.push(`${m}-${String(i).padStart(2, "0")}`);
    const earlier = (extra || [])
      .filter((d) => ISO_DAY.test(d) && d < out[0])
      .sort();
    const start = earlier[0];
    if (!start) return out;
    const merged = [];
    let cur = new Date(start + "T12:00:00Z");
    const last = new Date(out[out.length - 1] + "T12:00:00Z");
    while (cur <= last && merged.length < 62) {
      merged.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return merged.length ? merged : out;
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
  function addDay(target, day, rec) {
    if (!isChartDay(day)) return;
    if (!target[day]) target[day] = emptyDay();
    target[day].tokens_saved += Number(rec.tokens_saved || 0);
    target[day].tokens_in += Number(rec.tokens_in || 0);
    target[day].requests += Number(rec.requests || 0);
  }

  function aggregateUsage(payload) {
    const usage = payload.usage || {};
    const account = payload.account_usage || {};
    const month = account.month || utcYmd().slice(0, 7);
    const accountDays = {};
    for (const [day, rec] of Object.entries(account.by_day || {})) {
      addDay(accountDays, day, rec);
    }
    const keyDays = {};
    const keyRows = [];

    for (const k of payload.keys || []) {
      const snap = usage[k.id] || {};
      keyRows.push({
        label: k.name || k.prefix || "Key",
        value: Number(snap.total_tokens_saved || 0),
      });
      for (const [day, rec] of Object.entries(snap.by_day || {})) {
        addDay(keyDays, day, rec);
      }
    }

    const accountHasDays = Object.values(accountDays).some(
      (d) => d.tokens_in > 0 || d.tokens_saved > 0 || d.requests > 0
    );
    const sourceDays = accountHasDays ? accountDays : keyDays;
    const keys = monthKeys(month, utcYmd(), Object.keys(sourceDays));
    const byDay = Object.fromEntries(keys.map((k) => [k, emptyDay()]));
    for (const [day, rec] of Object.entries(sourceDays)) {
      if (!byDay[day]) byDay[day] = emptyDay();
      byDay[day].tokens_saved += rec.tokens_saved;
      byDay[day].tokens_in += rec.tokens_in;
      byDay[day].requests += rec.requests;
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

  function chartDayList(bundle) {
    const extra = Object.keys(bundle.byDay || {}).filter(isChartDay);
    const month = (bundle.account && bundle.account.month) || utcYmd().slice(0, 7);
    const keys = monthKeys(month, utcYmd(), extra);
    // Early in a billing month (day 1–3) a single point becomes a solid blue slab.
    // Fall back to a rolling 14-day window so the chart stays readable at 1M+.
    if (keys.length < 7) {
      const roll = dayKeys(14);
      const merged = [...new Set([...roll, ...keys, ...extra])].filter(isChartDay).sort();
      return merged.slice(-14);
    }
    return keys;
  }

  function meterFromBundle(bundle) {
    if (!bundle.byDay) bundle.byDay = {};
    const keys = chartDayList(bundle);
    for (const iso of keys) {
      if (!bundle.byDay[iso]) bundle.byDay[iso] = emptyDay();
    }
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

    // Month meter ahead of daily rows: fold the gap into the chart without
    // painting a flat full-height slab (equal weight on every day did that at 1M+).
    // Prefer real activity days; if none exist, ramp toward month-end.
    const gapSaved = saved - daySaved;
    const gapIn = tin - dayIn;
    const gapReq = req - dayReq;
    if (gapSaved > 500 || gapIn > 500 || gapReq > 0) {
      const hasActivity = keys.some((iso) => {
        const d = bundle.byDay[iso];
        return d && (d.requests || d.tokens_in || d.tokens_saved);
      });
      const weights = keys.map((iso, i) => {
        const d = bundle.byDay[iso];
        const active = d && (d.requests || d.tokens_in || d.tokens_saved);
        if (active) {
          return (
            8 +
            Math.max(
              Number(d.requests) || 0,
              Math.round((Number(d.tokens_saved) || 0) / 5000),
              2
            )
          );
        }
        if (!hasActivity) {
          // No daily rows — rising month shape, not a flat blue wall.
          const t = keys.length <= 1 ? 1 : (i + 1) / keys.length;
          return t * t;
        }
        // Tiny residual so the gap isn't a single needle, but peaks stay readable.
        return 0.12;
      });
      const wSum = weights.reduce((s, w) => s + w, 0) || keys.length || 1;
      let usedS = 0;
      let usedI = 0;
      let usedR = 0;
      keys.forEach((iso, i) => {
        const last = i === keys.length - 1;
        const share = weights[i] / wSum;
        const addS = last ? gapSaved - usedS : Math.round(gapSaved * share);
        const addI = last ? gapIn - usedI : Math.round(gapIn * share);
        const addR = last ? gapReq - usedR : Math.round(gapReq * share);
        usedS += addS;
        usedI += addI;
        usedR += addR;
        const cur = bundle.byDay[iso] || emptyDay();
        bundle.byDay[iso] = {
          tokens_saved: cur.tokens_saved + Math.max(0, addS),
          tokens_in: cur.tokens_in + Math.max(0, addI),
          requests: cur.requests + Math.max(0, addR),
        };
      });
      daySaved = saved;
      dayIn = tin;
      dayReq = req;
    }

    return { saved, tin, req, daySaved, dayIn, dayReq, keys };
  }

  function bundleToSeries(bundle) {
    const meter = meterFromBundle(bundle);
    const keys = meter.keys || chartDayList(bundle);
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

  const api = {
    dayKeys,
    monthKeys,
    labelDay,
    isChartDay,
    aggregateUsage,
    fakeKeysPayload,
    demoBundle,
    bundleToSeries,
    escapeHtml,
    sumAgents,
    sumKeys,
  };

  root.SCAnalyticsData = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
