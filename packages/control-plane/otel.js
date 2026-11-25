"use strict";

/**
 * OTLP/JSON export of Compression Trace + spend (ExportTraceServiceRequest shape).
 * POST the bundle as-is to any collector's /v1/traces endpoint. No ask/prompt bodies.
 */

const SPAN_KIND_SERVER = 2;
const STATUS_CODE_OK = 1;
const STATUS_CODE_ERROR = 2;

function spanId() {
  return require("crypto").randomBytes(8).toString("hex");
}

function traceId() {
  return require("crypto").randomBytes(16).toString("hex");
}

/** JS value → OTLP AnyValue. Returns null for values OTLP cannot carry (dropped). */
function anyValue(v) {
  if (v == null || v === "") return null;
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    // int64 is a JSON string in OTLP/JSON.
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }
  return { stringValue: String(v) };
}

/** Plain object → OTLP KeyValue list, skipping empty values. */
function toAttributes(obj = {}) {
  const out = [];
  for (const [key, raw] of Object.entries(obj)) {
    const value = anyValue(raw);
    if (value) out.push({ key, value });
  }
  return out;
}

/** OTLP KeyValue list → plain object (for tests and the ops UI). */
function fromAttributes(list = []) {
  const out = {};
  for (const { key, value = {} } of list) {
    if ("boolValue" in value) out[key] = value.boolValue;
    else if ("intValue" in value) out[key] = Number(value.intValue);
    else if ("doubleValue" in value) out[key] = value.doubleValue;
    else out[key] = value.stringValue;
  }
  return out;
}

function unixNano(ms) {
  return (BigInt(Math.max(0, Math.round(ms))) * 1_000_000n).toString();
}

/**
 * One ledger record → OTLP span (no ask/prompt bodies).
 */
function recordToOtelSpan(rec = {}, opts = {}) {
  const c = rec.compression || {};
  const start = Date.parse(rec.created_at || rec.updated_at || 0) || Date.now();
  const latency = Number(rec.latency_ms) || 0;
  const span = {
    traceId: opts.traceId || traceId(),
    spanId: spanId(),
    name: "sc.control_plane.request",
    kind: SPAN_KIND_SERVER,
    startTimeUnixNano: unixNano(start),
    endTimeUnixNano: unixNano(start + latency),
    attributes: toAttributes({
      "sc.request_id": rec.id,
      "sc.org_id": rec.org_id,
      "sc.agent_id": rec.agent_id,
      "sc.key_id": rec.key_id,
      "sc.status": rec.status,
      "sc.model_requested": rec.model_requested,
      "sc.model_routed": rec.model_routed,
      "sc.provider": rec.provider,
      "sc.actual_usd": Number(rec.actual_usd) || 0,
      "sc.reserved_usd": Number(rec.reserved_usd) || 0,
      "sc.compress.original_tokens": Number(c.original_tokens) || 0,
      "sc.compress.retained_tokens": Number(c.retained_tokens) || 0,
      "sc.compress.ratio": c.ratio != null ? Number(c.ratio) : null,
      "sc.compress.strategy": c.strategy,
      "sc.compress.dollars_avoided_est": Number(c.dollars_avoided_est) || 0,
      "sc.compress.route_model_changed": Boolean(c.meta?.economics?.model_changed),
      "sc.error_class": rec.error_class,
    }),
    status: rec.error_class
      ? { code: STATUS_CODE_ERROR, ...(rec.error_message ? { message: String(rec.error_message) } : {}) }
      : { code: STATUS_CODE_OK },
  };
  return span;
}

function exportOtelBundle(records = [], opts = {}) {
  const spans = (Array.isArray(records) ? records : []).map((r) => recordToOtelSpan(r, opts));
  return {
    resourceSpans: [
      {
        resource: {
          attributes: toAttributes({
            "service.name": opts.serviceName || "supercompress-control-plane",
            "service.version": opts.serviceVersion || "0.6.0",
            "deployment.environment": opts.environment || "private",
          }),
        },
        scopeSpans: [{ scope: { name: "sc.control_plane", version: "1" }, spans }],
      },
    ],
  };
}

module.exports = {
  recordToOtelSpan,
  exportOtelBundle,
  toAttributes,
  fromAttributes,
  spanId,
  traceId,
};
