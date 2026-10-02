"use strict";

/**
 * Ops insights — the revolutionary read model.
 * Turns Compression Trace + route economics into a single moat proof
 * LiteLLM cannot produce (compress-before-route dollars + unlocks).
 */

const { summarizeRequests, evaluateAlerts } = require("./obs");
const { exportOtelBundle } = require("./otel");

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
  econFromRec,
};
