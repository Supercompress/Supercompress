"use strict";

/**
 * Ops insights — the revolutionary read model.
 * Turns Compression Trace + route economics into a single moat proof
 * LiteLLM cannot produce (compress-before-route dollars + unlocks).
 */

const { summarizeRequests, evaluateAlerts } = require("./obs");
const { exportOtelBundle } = require("./otel");
const { obsRow } = require("./request-obs");

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

const r6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

/**
 * Gateway aggregates from the per-request obs records: volume, error rate, latency and
 * TTFT percentiles, spend, and savings split by routing vs compression; plus the most
 * recent rows for the per-request table. Rows without meta.obs (older ledgers) still count
 * toward volume, errors, latency and spend.
 */
function buildGatewayView(rows = [], opts = {}) {
  let errors = 0;
  let spend = 0;
  let list = 0;
  let savedRouting = 0;
  let savedCompression = 0;
  let withObs = 0;
  let autoRouted = 0;
  let retried = 0;
  const lat = [];
  const ttft = [];
  const byCode = {};
  for (const r of rows) {
    const o = r.meta?.obs;
    if (r.error_class || o?.error) {
      errors += 1;
      const code = o?.error?.code || "unknown";
      byCode[code] = (byCode[code] || 0) + 1;
    }
    const l = Number(o?.latency_ms ?? r.latency_ms);
    if (Number.isFinite(l)) lat.push(l);
    spend += Number(o?.cost?.charged_usd ?? r.actual_usd) || 0;
    if (!o) continue;
    withObs += 1;
    if (o.routing?.mode === "auto") autoRouted += 1;
    if (o.provider?.retries > 0) retried += 1;
    if (Number.isFinite(Number(o.provider?.ttft_ms)) && o.provider?.ttft_ms != null) ttft.push(Number(o.provider.ttft_ms));
    list += Number(o.cost?.list_usd) || 0;
    if (!o.error) {
      savedRouting += Number(o.cost?.saved_routing_usd) || 0;
      savedCompression += Number(o.cost?.saved_compression_usd) || 0;
    }
  }
  lat.sort((a, b) => a - b);
  ttft.sort((a, b) => a - b);
  const recentN = Math.max(0, Number(opts.recent_limit ?? 50));
  return {
    requests: rows.length,
    requests_with_obs: withObs,
    errors,
    error_rate: rows.length ? Math.round((errors / rows.length) * 1e4) / 1e4 : 0,
    errors_by_code: byCode,
    auto_routed: autoRouted,
    retried,
    latency_ms: { p50: percentile(lat, 50), p95: percentile(lat, 95) },
    ttft_ms: { p50: percentile(ttft, 50), p95: percentile(ttft, 95) },
    spend_usd: r6(spend),
    list_usd: r6(list),
    savings: {
      routing_usd: r6(savedRouting),
      compression_usd: r6(savedCompression),
      total_usd: r6(savedRouting + savedCompression),
    },
    recent: rows.slice(0, recentN).map(obsRow),
  };
}

function econFromRec(r) {
  return r?.compression?.meta?.economics || r?.meta?.economics || null;
}

/**
 * @param {object[]} records — ledger rows (no asks/prompts)
 * @param {{ budget_usd?: number, org_id?: string, serviceName?: string }} opts
 */
function buildOpsInsights(records = [], opts = {}) {
  const rows = Array.isArray(records) ? records : [];
  const filtered = opts.org_id ? rows.filter((r) => r.org_id === opts.org_id) : rows;
  const summary = summarizeRequests(filtered);
  summary.error_rate = summary.requests ? Math.round((summary.errors / summary.requests) * 1e4) / 1e4 : 0;
  const gateway = buildGatewayView(filtered, opts);
  const alerts = evaluateAlerts(summary, opts);

  let model_changed = 0;
  let unlocks = 0;
  let route_dollars = 0;
  let token_dollars = 0;
  let with_econ = 0;
  const unlock_examples = [];

  for (const r of filtered) {
    const e = econFromRec(r);
    if (!e) continue;
    with_econ += 1;
    if (e.model_changed) model_changed += 1;
    if (e.unlocks_smaller_context_model) {
      unlocks += 1;
      if (unlock_examples.length < 5) {
        unlock_examples.push({
          request_id: r.id,
          without: e.without_compress?.model,
          with: e.with_compress?.model,
          original_tokens: e.original_tokens,
          retained_tokens: e.retained_tokens,
        });
      }
    }
    route_dollars += Number(e.dollars_saved_est) || 0;
    token_dollars += Number(r.compression?.meta?.dollars_avoided_tokens_est) || 0;
  }

  const dollars_route = Math.round(route_dollars * 1e6) / 1e6;
  const dollars_tokens = Math.round(token_dollars * 1e6) / 1e6;
  const dollars_total =
    Math.round(
      ((summary.dollars_avoided_est || 0) > 0
        ? summary.dollars_avoided_est
        : dollars_route + dollars_tokens) *
        1e6
    ) / 1e6;

  const moat = {
    requests_with_economics: with_econ,
    model_changed_count: model_changed,
    unlock_count: unlocks,
    unlock_examples,
    dollars_avoided_route_est: dollars_route,
    dollars_avoided_tokens_est: dollars_tokens,
    dollars_avoided_total_est: dollars_total,
    compress_then_route: true,
    vs_litellm:
      "LiteLLM routes the request the client sent. SuperCompress routes the request after keep — and proves the $ delta.",
  };

  const headline =
    unlocks > 0
      ? `Compression unlocked ${unlocks} request(s) that would not fit / admit without keep`
      : dollars_total > 0
        ? `Estimated $${dollars_total} avoided via compress-then-route`
        : summary.requests
          ? `${summary.requests} requests observed — enable SC_CP_TRACE for economics proof`
          : "No ledger rows yet";

  return {
    generated_at: new Date().toISOString(),
    confidential: true,
    headline,
    summary,
    gateway,
    alerts,
    moat,
  };
}

function buildOpsOtelExport(records = [], opts = {}) {
  const rows = Array.isArray(records) ? records : [];
  const filtered = opts.org_id ? rows.filter((r) => r.org_id === opts.org_id) : rows;
  return exportOtelBundle(filtered, opts);
}

module.exports = {
  buildOpsInsights,
  buildOpsOtelExport,
  buildGatewayView,
  econFromRec,
};
