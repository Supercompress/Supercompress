"use strict";

/**
 * Observability read models over ledger records + Compression Trace.
 */
function summarizeRequests(records = []) {
  const rows = Array.isArray(records) ? records : [];
  let spend = 0;
  let reserved = 0;
  let errors = 0;
  let finalized = 0;
  let latencySum = 0;
  let latencyN = 0;
  let orig = 0;
  let kept = 0;
  let dollarsAvoided = 0;
  const byAgent = new Map();
  const byStatus = new Map();

  for (const r of rows) {
    byStatus.set(r.status, (byStatus.get(r.status) || 0) + 1);
    if (r.status === "finalized") finalized += 1;
    if (r.error_class) errors += 1;
    if (r.actual_usd != null) spend += Number(r.actual_usd) || 0;
    if (r.reserved_usd != null) reserved += Number(r.reserved_usd) || 0;
    if (r.latency_ms != null && Number.isFinite(Number(r.latency_ms))) {
      latencySum += Number(r.latency_ms);
      latencyN += 1;
    }
    const c = r.compression;
    if (c) {
      orig += Number(c.original_tokens) || 0;
      kept += Number(c.retained_tokens) || 0;
      dollarsAvoided += Number(c.dollars_avoided_est) || 0;
    }
    const agent = r.agent_id || "unknown";
    const cur = byAgent.get(agent) || { agent_id: agent, requests: 0, spend_usd: 0, errors: 0 };
    cur.requests += 1;
    cur.spend_usd += Number(r.actual_usd) || 0;
    if (r.error_class) cur.errors += 1;
    byAgent.set(agent, cur);
  }

  const ratio = orig > 0 ? Math.round((kept / orig) * 1e6) / 1e6 : null;
  const latencies = rows
    .map((r) => Number(r.latency_ms))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const pct = (p) => {
    if (!latencies.length) return null;
    const idx = Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1);
    return latencies[Math.max(0, idx)];
  };

  const top_agents = [...byAgent.values()]
    .sort((a, b) => b.spend_usd - a.spend_usd || b.requests - a.requests)
    .slice(0, 20);

  return {
    requests: rows.length,
    finalized,
    errors,
    spend_usd: Math.round(spend * 1e6) / 1e6,
    reserved_usd: Math.round(reserved * 1e6) / 1e6,
    dollars_avoided_est: Math.round(dollarsAvoided * 1e6) / 1e6,
    compression: {
      original_tokens: orig,
      retained_tokens: kept,
      ratio,
    },
    latency_ms: {
      avg: latencyN ? Math.round((latencySum / latencyN) * 100) / 100 : null,
      p50: pct(50),
      p95: pct(95),
    },
    by_status: Object.fromEntries(byStatus),
    top_agents,
  };
}

/**
 * Simple alert stubs — budget 80/100%, error spike.
 */
function evaluateAlerts(summary, opts = {}) {
  const alerts = [];
  const budget = opts.budget_usd != null ? Number(opts.budget_usd) : null;
  if (budget != null && budget > 0) {
    const pct = (summary.spend_usd / budget) * 100;
    if (pct >= 100) alerts.push({ level: "critical", code: "budget_100", pct });
    else if (pct >= 80) alerts.push({ level: "warn", code: "budget_80", pct });
  }
  const errRate = summary.requests ? summary.errors / summary.requests : 0;
  const errThreshold = opts.error_rate_threshold ?? 0.2;
  if (summary.requests >= (opts.min_requests_for_error_alert ?? 5) && errRate >= errThreshold) {
    alerts.push({ level: "warn", code: "error_spike", error_rate: errRate });
  }
  if (
    summary.compression?.ratio != null &&
    summary.compression.ratio > (opts.compress_skip_ratio_warn ?? 0.98) &&
    summary.requests >= 5
  ) {
    alerts.push({
      level: "info",
      code: "compress_skip_anomaly",
      ratio: summary.compression.ratio,
    });
  }
  return alerts;
}

/**
 * Compact summary for eval harness aggregates (Phase 6 seat B).
 * Does not invent public marketing numbers — internal comparison only.
 */
function summarizeEvalComparison(input = {}) {
  const aggregates = input.aggregates || {};
  const comparison = input.comparison || {};
  const paths = Object.keys(aggregates);
  return {
    task_metrics: input.task_count != null ? Number(input.task_count) : null,
    paths,
    spend_per_successful_task: Object.fromEntries(
      paths.map((p) => [p, aggregates[p]?.spend_per_successful_task ?? null])
    ),
    success_rate: Object.fromEntries(paths.map((p) => [p, aggregates[p]?.success_rate ?? null])),
    quality_avg: Object.fromEntries(paths.map((p) => [p, aggregates[p]?.quality_avg ?? null])),
    dollars_avoided_est: Object.fromEntries(
      paths.map((p) => [p, aggregates[p]?.dollars_avoided_est ?? null])
    ),
    gateway_vs_direct: comparison.gateway_vs_direct || null,
    notes: comparison.notes || [],
    // Optional harden fields when harness passes them through
    both_success_cheaper_rate: comparison.gateway_vs_direct?.both_success_cheaper_rate ?? null,
    lose_quality_tasks: Array.isArray(input.lose_quality_tasks) ? input.lose_quality_tasks : null,
  };
}

module.exports = {
  summarizeRequests,
  evaluateAlerts,
  summarizeEvalComparison,
};
