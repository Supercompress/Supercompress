"use strict";

/**
 * Day-spend rollup from ledger rows (org / key / agent).
 * Powers max_usd_per_day admission — gateway-native, not Auth claims.
 */

function startOfUtcDay(ms = Date.now()) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * @param {object[]} records
 * @param {{ org_id?: string, key_id?: string, agent_id?: string, nowMs?: number }} [filter]
 */
function sumDaySpendUsd(records = [], filter = {}) {
  const start = startOfUtcDay(filter.nowMs != null ? filter.nowMs : Date.now());
  let sum = 0;
  for (const r of Array.isArray(records) ? records : []) {
    if (filter.org_id && r.org_id !== filter.org_id) continue;
    if (filter.key_id && r.key_id !== filter.key_id) continue;
    if (filter.agent_id && r.agent_id !== filter.agent_id) continue;
    const ts = Date.parse(r.created_at || r.updated_at || 0);
    if (!Number.isFinite(ts) || ts < start) continue;
    if (r.actual_usd != null) sum += Number(r.actual_usd) || 0;
    else if (r.status !== "finalized" && r.reserved_usd != null) {
      // In-flight holds count against the day so concurrent bursts cannot overshoot.
      sum += Number(r.reserved_usd) || 0;
    }
  }
  return Math.round(sum * 1e6) / 1e6;
}

module.exports = {
  startOfUtcDay,
  sumDaySpendUsd,
};
