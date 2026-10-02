"use strict";

/**
 * OpenTelemetry-shaped export of Compression Trace + spend (JSON lines / bundle).
 * No vendor lock-in — ops can ship to any OTLP collector later.
 */

function spanId() {
  return require("crypto").randomBytes(8).toString("hex");
}

function traceId() {
  return require("crypto").randomBytes(16).toString("hex");
}

/**
 * One ledger record → OTel-like span attributes (no ask/prompt bodies).
 */
function recordToOtelSpan(rec = {}, opts = {}) {
  const c = rec.compression || {};
  const start = Date.parse(rec.created_at || rec.updated_at || 0) || Date.now();
  const latency = Number(rec.latency_ms) || 0;
  return {
    traceId: opts.traceId || traceId(),
    spanId: spanId(),
    name: "sc.control_plane.request",
    kind: "SERVER",
    startTimeUnixNano: String(start * 1e6),
    endTimeUnixNano: String((start + latency) * 1e6),
    attributes: {
      "sc.request_id": rec.id || "",
      "sc.org_id": rec.org_id || "",
      "sc.agent_id": rec.agent_id || "",
      "sc.key_id": rec.key_id || "",
      "sc.status": rec.status || "",
      "sc.model_requested": rec.model_requested || "",
      "sc.model_routed": rec.model_routed || "",
      "sc.provider": rec.provider || "",
      "sc.actual_usd": Number(rec.actual_usd) || 0,
      "sc.reserved_usd": Number(rec.reserved_usd) || 0,
      "sc.compress.original_tokens": Number(c.original_tokens) || 0,
      "sc.compress.retained_tokens": Number(c.retained_tokens) || 0,
      "sc.compress.ratio": c.ratio != null ? Number(c.ratio) : null,
      "sc.compress.strategy": c.strategy || "",
      "sc.compress.dollars_avoided_est": Number(c.dollars_avoided_est) || 0,
      "sc.compress.route_model_changed": Boolean(c.meta?.economics?.model_changed),
      "sc.error_class": rec.error_class || "",
    },
    status: {
      code: rec.error_class ? "ERROR" : "OK",
      message: rec.error_message || undefined,
    },
  };
}

function exportOtelBundle(records = [], opts = {}) {
  const resource = {
    attributes: {
      "service.name": opts.serviceName || "supercompress-control-plane",
      "service.version": opts.serviceVersion || "0.6.0",
      "deployment.environment": opts.environment || "private",
    },
  };
  const spans = (Array.isArray(records) ? records : []).map((r) =>
    recordToOtelSpan(r, opts)
  );
  return {
    resourceSpans: [
      {
        resource,
        scopeSpans: [
          {
            scope: { name: "sc.control_plane", version: "1" },
            spans,
          },
        ],
      },
    ],
    confidential: true,
    note: "No user asks / prompts included — Compression Trace sizes + spend only.",
  };
}

module.exports = {
  recordToOtelSpan,
  exportOtelBundle,
  spanId,
  traceId,
};
