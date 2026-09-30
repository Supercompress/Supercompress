/**
 * Aggregate all-account usage from Auth claims (+ optional store daily rows).
 * Used by the founder dashboard on internal.supercompress.dev.
 */

const { expandPackedDays, fillMonthGap, mergeDays } = require("./usage-days");

const STUB_RE = /^(sck_|sc_lnk_|sc_at_|sc_ac_|sc_aff_)/;

function monthKey(d = new Date()) {
  return d.toISOString().slice(0, 7);
}

function cutPct(saved, tin) {
  const s = Number(saved) || 0;
  const t = Number(tin) || 0;
  if (t <= 0) return 0;
  return Math.round((s / t) * 10000) / 100;
}

function emptyDay() {
  return { tokens_saved: 0, tokens_in: 0, tokens_out: 0, requests: 0 };
}

function isHumanUser(user) {
  if (!user || user.disabled) return false;
  if (STUB_RE.test(String(user.uid || ""))) return false;
  return Boolean(user.email || user.providerData?.some((p) => p.email));
}

function rowFromUser(user, month = monthKey()) {
  const claims = user.customClaims || {};
  const usage = claims.sc_usage || {};
  const usageMonth = String(usage.month || "");
  const current = usageMonth === month;
  const tokens_in = Number(usage.tokens_in || 0) || 0;
  const tokens_out = Number(usage.tokens_out || 0) || 0;
  const tokens_saved = Number(usage.tokens_saved || 0) || 0;
  const requests = Number(usage.requests || 0) || 0;
  return {
    uid: user.uid,
    email: user.email || user.providerData?.find((p) => p.email)?.email || "",
    name: user.displayName || "",
    plan: String(claims.sc_plan || "free"),
    month: usageMonth || null,
    current_month: current,
    tokens_in: current ? tokens_in : 0,
    tokens_out: current ? tokens_out : 0,
    tokens_saved: current ? tokens_saved : 0,
    requests: current ? requests : 0,
    recorded_tokens_in: tokens_in,
    recorded_tokens_saved: tokens_saved,
    recorded_requests: requests,
    cut_pct: cutPct(current ? tokens_saved : tokens_saved, current ? tokens_in : tokens_in),
    created_at: user.metadata?.creationTime || null,
    heard: claims.sc_heard || null,
    onboard_done: Boolean(claims.sc_onboard_done),
    onboard_skipped: Boolean(claims.sc_onboard_skipped),
    by_day: current
      ? fillMonthGap(
          expandPackedDays({ m: month, d: usage.d || {} }, month),
          { tokens_in, tokens_out, tokens_saved, requests },
          month
        ).by_day
      : {},
  };
}

function summarizeRows(rows, month = monthKey()) {
  const humans = rows.filter((r) => r.email);
  const withUsage = humans.filter((r) => r.tokens_in > 0 || r.requests > 0);
  const totals = humans.reduce(
    (acc, r) => {
      acc.tokens_in += r.tokens_in;
      acc.tokens_out += r.tokens_out;
      acc.tokens_saved += r.tokens_saved;
      acc.requests += r.requests;
      acc.recorded_tokens_in += r.recorded_tokens_in;
      acc.recorded_tokens_saved += r.recorded_tokens_saved;
      return acc;
    },
    {
      tokens_in: 0,
      tokens_out: 0,
      tokens_saved: 0,
      requests: 0,
      recorded_tokens_in: 0,
      recorded_tokens_saved: 0,
    }
  );
  const processed = Math.max(totals.tokens_in, totals.recorded_tokens_in);
  const savedAll = Math.max(totals.tokens_saved, totals.recorded_tokens_saved);
  const plans = {};
  const heard = {};
  let heard_answered = 0;
  let onboard_done = 0;
  let onboard_skipped = 0;
  for (const r of humans) {
    const p = r.plan || "free";
    plans[p] = (plans[p] || 0) + 1;
    if (r.heard) {
      heard_answered += 1;
      heard[r.heard] = (heard[r.heard] || 0) + 1;
    }
    if (r.onboard_done) onboard_done += 1;
    if (r.onboard_skipped) onboard_skipped += 1;
  }
  const leaderboard = humans
    .slice()
    .sort((a, b) => b.tokens_in - a.tokens_in || b.recorded_tokens_in - a.recorded_tokens_in)
    .map((r, i) => ({ rank: i + 1, ...r, cut_pct: cutPct(r.tokens_saved || r.recorded_tokens_saved, r.tokens_in || r.recorded_tokens_in) }));

  return {
    month,
    totals: {
      month,
      users: humans.length,
      users_with_usage: withUsage.length,
      requests: totals.requests,
      tokens_in: totals.tokens_in,
      tokens_out: totals.tokens_out,
      tokens_saved: totals.tokens_saved,
      processed,
      cut_pct: cutPct(savedAll, processed),
    },
    plans: Object.entries(plans)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value),
    heard: Object.entries(heard)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value),
    onboard: { answered: heard_answered, done: onboard_done, skipped: onboard_skipped },
    leaderboard,
  };
}

function mergeStoreDays(store) {
  const byDay = {};
  const usage = store?.usage || {};
  for (const snap of Object.values(usage)) {
    for (const [day, rec] of Object.entries(snap.by_day || {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      if (!byDay[day]) byDay[day] = emptyDay();
      byDay[day].tokens_in += Number(rec.tokens_in || 0);
      byDay[day].tokens_out += Number(rec.tokens_out || 0);
      byDay[day].tokens_saved += Number(rec.tokens_saved || 0);
      byDay[day].requests += Number(rec.requests || 0);
    }
  }
  return byDay;
}

function mergeRowDays(rows) {
  let byDay = {};
  for (const r of rows || []) {
    byDay = mergeDays(byDay, r.by_day || {});
  }
  return byDay;
}

function analyticsBundle({ totals, leaderboard, plans, byDay }) {
  return {
    live: true,
    byDay: byDay || {},
    account: {
      month: totals.month,
      requests: totals.requests,
      tokens_in: totals.tokens_in,
      tokens_out: totals.tokens_out,
      tokens_saved: totals.tokens_saved,
    },
    keyTotals: {
      tokens_in: totals.tokens_in,
      tokens_out: totals.tokens_out,
      tokens_saved: totals.tokens_saved,
      requests: totals.requests,
    },
    agentTotals: { tokens_in: 0, tokens_saved: 0, tokens_out: 0, requests: 0 },
    keys: leaderboard.slice(0, 8).map((r) => ({
      label: r.email || r.name || r.uid,
      value: r.tokens_saved || r.recorded_tokens_saved,
    })),
    agents: plans,
  };
}

module.exports = {
  monthKey,
  cutPct,
  isHumanUser,
  rowFromUser,
  summarizeRows,
  mergeStoreDays,
  mergeRowDays,
  analyticsBundle,
  STUB_RE,
};
