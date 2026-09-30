/**
 * Month-bucket projection for coding_agent_usage docs.
 * Kept free of Firebase so unit tests stay lightweight.
 */

/**
 * Project agent docs onto a single billing month.
 * Legacy docs without `months` only count if last_seen falls in that month
 * (avoids September inheriting August lifetime totals).
 */
function agentUsageForMonth(agents, month) {
  const m = String(month || new Date().toISOString().slice(0, 7));
  const out = {};
  for (const [name, snap] of Object.entries(agents || {})) {
    if (!snap || typeof snap !== "object") continue;
    let bucket = null;
    if (snap.months && typeof snap.months === "object" && snap.months[m]) {
      bucket = snap.months[m];
    } else if (!snap.months) {
      const last = String(snap.last_seen || snap.first_seen || "");
      if (last.startsWith(m)) bucket = snap;
    }
    if (!bucket) continue;
    out[name] = {
      requests: bucket.requests || 0,
      tokens_in: bucket.tokens_in || 0,
      tokens_out: bucket.tokens_out || 0,
      tokens_saved: bucket.tokens_saved || 0,
      first_seen: bucket.first_seen || snap.first_seen || null,
      last_seen: bucket.last_seen || snap.last_seen || null,
      last_pct: bucket.last_pct != null ? bucket.last_pct : snap.last_pct ?? null,
      last_source: bucket.last_source || snap.last_source || null,
      latency_sum_ms: bucket.latency_sum_ms || 0,
      latency_samples: bucket.latency_samples || 0,
      last_latency_ms: bucket.last_latency_ms != null ? bucket.last_latency_ms : snap.last_latency_ms ?? null,
      avg_latency_ms: bucket.avg_latency_ms != null ? bucket.avg_latency_ms : snap.avg_latency_ms ?? null,
      month: m,
    };
  }
  return out;
}

module.exports = { agentUsageForMonth };
