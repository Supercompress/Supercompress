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

    // If we only have month totals (no ISO by_day), park them on today so the chart isn't blank.
    if (daySaved === 0 && dayReq === 0 && (saved > 0 || req > 0)) {
      const today = keys[keys.length - 1];
      const ratio = tin > 0 ? saved / tin : 0.55;
      bundle.byDay[today] = {
        tokens_saved: saved,
        tokens_in: tin || Math.round(saved / Math.max(ratio, 0.01)),
        requests: req || 1,
      };
      return meterFromBundle({ ...bundle, account: null, keyTotals: null, agentTotals: null });
    }

    return { saved, tin, req, daySaved, dayIn, dayReq };
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
      deltaLabel = meter.daySaved === 0 && saved > 0 ? "month total · daily starts next call" : "new activity";
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
    labelDay,
    isChartDay,
    aggregateUsage,
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
