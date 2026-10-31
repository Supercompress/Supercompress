/**
 * Compact per-day usage on Auth claims (`sc_usage.d`) and read-time reconstruction.
 * Firestore is off by default, so monthly meters had no daily series — charts
 * looked like "only the last few days" after the client dumped the gap on today.
 */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function monthKey(d = new Date()) {
  return d.toISOString().slice(0, 7);
}

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function isIsoDay(day) {
  return ISO_DAY.test(String(day || ""));
}

function emptyDay() {
  return { tokens_in: 0, tokens_out: 0, tokens_saved: 0, requests: 0 };
}

function daysInMonth(month) {
  const [y, m] = String(month || "").split("-").map(Number);
  if (!y || !m) return 31;
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function monthDayKeys(month = monthKey(), throughIso = dayKey()) {
  const m = String(month || monthKey());
  const end =
    String(throughIso || "").slice(0, 7) === m
      ? Math.max(1, Number(String(throughIso).slice(8, 10)) || 1)
      : daysInMonth(m);
  const out = [];
  for (let i = 1; i <= end; i++) {
    out.push(`${m}-${String(i).padStart(2, "0")}`);
  }
  return out;
}

function trimPackedDays(packed, keep = 16) {
  const d = { ...(packed?.d || {}) };
  const keys = Object.keys(d).sort();
  if (keys.length <= keep) return { m: packed?.m, d };
  const next = {};
  for (const k of keys.slice(-keep)) next[k] = d[k];
  return { m: packed?.m, d: next };
}

function bumpPackedDays(prev, stats = {}, now = new Date()) {
  const day = isIsoDay(stats.day) ? stats.day : dayKey(now);
  const month = String(stats.month || day.slice(0, 7));
  const src = prev && prev.m === month ? { ...(prev.d || {}) } : {};
  const dd = day.slice(8, 10);
  const cur = Array.isArray(src[dd]) ? src[dd] : [0, 0, 0];
  src[dd] = [
    (Number(cur[0]) || 0) + Math.max(0, Number(stats.tokens_in) || 0),
    (Number(cur[1]) || 0) + Math.max(0, Number(stats.tokens_saved) || 0),
    (Number(cur[2]) || 0) + Math.max(0, Number(stats.requests) || 1),
  ];
  return trimPackedDays({ m: month, d: src }, 16);
}

function expandPackedDays(packed, month = monthKey()) {
  const m = String(packed?.m || month);
  const out = {};
  if (!packed || packed.m !== m || !packed.d || typeof packed.d !== "object") return out;
  for (const [dd, rec] of Object.entries(packed.d)) {
    const iso = `${m}-${String(dd).padStart(2, "0")}`;
    if (!isIsoDay(iso)) continue;
    const tin = Number(Array.isArray(rec) ? rec[0] : rec.tokens_in) || 0;
    const saved = Number(Array.isArray(rec) ? rec[1] : rec.tokens_saved) || 0;
    const req = Number(Array.isArray(rec) ? rec[2] : rec.requests) || 0;
    out[iso] = {
      tokens_in: tin,
      tokens_saved: saved,
      tokens_out: Math.max(0, tin - saved),
      requests: req,
    };
  }
  return out;
}

function daysFromRecentBilling(recent, month = monthKey()) {
  const out = {};
  for (const row of Array.isArray(recent) ? recent : []) {
    const t = Number(row?.t || 0);
    if (!t) continue;
    const iso = new Date(t).toISOString().slice(0, 10);
    if (iso.slice(0, 7) !== month) continue;
    if (!out[iso]) out[iso] = emptyDay();
    out[iso].tokens_in += Number(row.tin || 0);
    out[iso].tokens_out += Number(row.tout || 0);
    out[iso].tokens_saved += Number(row.ts || 0);
    out[iso].requests += 1;
  }
  return out;
}

function mergeDays(...maps) {
  const out = {};
  for (const map of maps) {
    for (const [day, rec] of Object.entries(map || {})) {
      if (!isIsoDay(day)) continue;
      if (!out[day]) out[day] = emptyDay();
      out[day].tokens_in += Number(rec.tokens_in || 0);
      out[day].tokens_out += Number(rec.tokens_out || 0);
      out[day].tokens_saved += Number(rec.tokens_saved || 0);
      out[day].requests += Number(rec.requests || 0);
    }
  }
  return out;
}

function addDays(a, b) {
  const out = { ...(a || {}) };
  for (const [day, rec] of Object.entries(b || {})) {
    if (!isIsoDay(day)) continue;
    const cur = out[day] || emptyDay();
    out[day] = {
      tokens_in: (cur.tokens_in || 0) + (Number(rec.tokens_in) || 0),
      tokens_out: (cur.tokens_out || 0) + (Number(rec.tokens_out) || 0),
      tokens_saved: (cur.tokens_saved || 0) + (Number(rec.tokens_saved) || 0),
      requests: (cur.requests || 0) + (Number(rec.requests) || 0),
    };
  }
  return out;
}

/**
 * When monthly totals exist but daily rows don't cover them, spread the gap
 * across the calendar month (weighted by known-day activity) instead of
 * dumping everything onto today.
 */
function fillMonthGap(byDay, totals = {}, month = monthKey(), throughIso = dayKey()) {
  const keys = monthDayKeys(month, throughIso);
  const recorded = { ...(byDay || {}) };
  let dayIn = 0;
  let daySaved = 0;
  let dayReq = 0;
  for (const iso of keys) {
    const d = recorded[iso] || emptyDay();
    dayIn += d.tokens_in;
    daySaved += d.tokens_saved;
    dayReq += d.requests;
  }
  const gapIn = Math.max(0, Number(totals.tokens_in || 0) - dayIn);
  const gapSaved = Math.max(0, Number(totals.tokens_saved || 0) - daySaved);
  const gapReq = Math.max(0, Number(totals.requests || 0) - dayReq);
  if (gapIn < 500 && gapSaved < 500 && gapReq <= 0) {
    return { by_day: recorded, source: "recorded" };
  }

  // Never paint a flat baseline onto days with no recorded activity.
  // Prefer real activity days; if none exist, ramp toward month-end.
  const hasActivity = keys.some((iso) => {
    const d = recorded[iso];
    return d && (d.requests || d.tokens_in || d.tokens_saved);
  });
  const weights = keys.map((iso, i) => {
    const d = recorded[iso];
    const active = d && (d.requests || d.tokens_in || d.tokens_saved);
    if (active) {
      return 8 + Math.max(Number(d.requests) || 0, d.tokens_in > 0 ? 2 : 0);
    }
    if (!hasActivity) {
      const t = keys.length <= 1 ? 1 : (i + 1) / keys.length;
      return t * t;
    }
    return 0;
  });
  const wSum = weights.reduce((s, w) => s + w, 0) || keys.length;
  const out = { ...recorded };
  let usedIn = 0;
  let usedSaved = 0;
  let usedReq = 0;
  const lastWeighted = (() => {
    for (let i = keys.length - 1; i >= 0; i--) if (weights[i] > 0) return i;
    return keys.length - 1;
  })();
  keys.forEach((iso, i) => {
    if (weights[i] <= 0) return;
    const last = i === lastWeighted;
    const share = weights[i] / wSum;
    const addIn = last ? gapIn - usedIn : Math.round(gapIn * share);
    const addSaved = last ? gapSaved - usedSaved : Math.round(gapSaved * share);
    const addReq = last ? gapReq - usedReq : Math.round(gapReq * share);
    usedIn += addIn;
    usedSaved += addSaved;
    usedReq += addReq;
    const cur = out[iso] || emptyDay();
    out[iso] = {
      tokens_in: cur.tokens_in + Math.max(0, addIn),
      tokens_saved: cur.tokens_saved + Math.max(0, addSaved),
      tokens_out: cur.tokens_out + Math.max(0, addIn - addSaved),
      requests: cur.requests + Math.max(0, addReq),
    };
  });
  return {
    by_day: out,
    source: Object.keys(recorded).length ? "mixed" : "reconstructed",
  };
}

function accountDaysFromClaims(claims = {}, month = monthKey()) {
  const usage = claims.sc_usage || {};
  const packedMonth = usage.month === month ? { m: month, d: usage.d || {} } : null;
  const recorded = expandPackedDays(packedMonth, month);
  const fromRecent = Object.keys(recorded).length
    ? {}
    : daysFromRecentBilling(claims.sc_recent_billing, month);
  const merged = mergeDays(recorded, fromRecent);
  const totals =
    usage.month === month
      ? {
          tokens_in: usage.tokens_in,
          tokens_saved: usage.tokens_saved,
          tokens_out: usage.tokens_out,
          requests: usage.requests,
        }
      : {};
  return fillMonthGap(merged, totals, month);
}

module.exports = {
  monthKey,
  dayKey,
  isIsoDay,
  emptyDay,
  daysInMonth,
  monthDayKeys,
  trimPackedDays,
  bumpPackedDays,
  expandPackedDays,
  daysFromRecentBilling,
  mergeDays,
  addDays,
  fillMonthGap,
  accountDaysFromClaims,
};
