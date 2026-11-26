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

/** Stable 32-hex trace id per request id, so re-exports of a row join the same trace. */
function traceIdFor(requestId) {
  if (!requestId) return traceId();
  return require("crypto").createHash("sha256").update(String(requestId)).digest("hex").slice(0, 32);
}

/**
 * Flatten the per-request obs record (meta.obs) into sc.* attributes.
 * Ids, model names, codes, counts, timings and dollars only.
 */
function obsAttributes(o) {
  if (!o) return {};
  const r = o.routing || {};
  const cl = r.classifier || {};
  const c = o.compression || {};
  const p = o.provider || {};
  const cost = o.cost || {};
  const e = o.error || {};
  return {
    "sc.stream": o.stream,
    "sc.latency_ms": o.latency_ms,
    "sc.route.mode": r.mode,
    "sc.route.strategy": r.strategy,
    "sc.route.reason": r.reason,
    "sc.route.classifier.tier": cl.tier,
    "sc.route.classifier.category": cl.category,
    "sc.route.classifier.difficulty": cl.difficulty,
    "sc.route.classifier.reasons": Array.isArray(cl.reasons) && cl.reasons.length ? cl.reasons.join(",") : null,
    "sc.route.classifier.difficulty_score": cl.difficulty_score,
    "sc.compress.engine": c.engine,
    "sc.compress.mode": c.mode,
    "sc.compress.passthrough_reason": c.passthrough_reason,
    "sc.compress.latency_ms": c.latency_ms,
    "sc.provider.status": p.status,
    "sc.provider.ttft_ms": p.ttft_ms,
    "sc.provider.latency_ms": p.latency_ms,
    "sc.provider.attempts": p.attempts,
    "sc.provider.retries": p.retries,
    "sc.provider.finish_reason": p.finish_reason,
    "sc.provider.usage_estimated": p.status ? Boolean(p.usage_estimated) : null,
    "gen_ai.usage.input_tokens": p.input_tokens,
    "gen_ai.usage.output_tokens": p.output_tokens,
    "sc.usage.cached_input_tokens": p.cached_input_tokens,
    "sc.cost.list_usd": cost.list_usd,
    "sc.cost.charged_usd": cost.charged_usd,
    "sc.cost.baseline_model": cost.baseline_model,
    "sc.cost.baseline_basis": cost.baseline_basis,
    "sc.cost.baseline_usd": cost.baseline_usd,
    "sc.savings.routing_usd": cost.saved_routing_usd,
    "sc.savings.compression_usd": cost.saved_compression_usd,
    "sc.savings.total_usd": cost.saved_total_usd,
    "sc.error.code": e.code,
    "http.response.status_code": e.http_status ?? (o.error === null ? 200 : null),
  };
}

function unixNano(ms) {
  return (BigInt(Math.max(0, Math.round(ms))) * 1_000_000n).toString();
}

/**
 * One ledger record → OTLP span (no ask/prompt bodies).
 */
function recordToOtelSpan(rec = {}, opts = {}) {
  const c = rec.compression || {};
  const o = rec.meta?.obs || null;
  const start = Date.parse(rec.created_at || rec.updated_at || 0) || Date.now();
  const latency = Number(rec.latency_ms) || 0;
  // One event per provider attempt that failed (the fallback chain), metadata only.
  const events = (o?.provider?.fallbacks || []).map((f, i) => ({
    name: "sc.provider.fallback",
    timeUnixNano: unixNano(start),
    attributes: toAttributes({
      "sc.attempt": i,
      "sc.provider": f.provider,
      "sc.model": f.model,
      "sc.error.code": f.code,
      "http.response.status_code": f.http_status,
      "sc.duration_ms": f.ms,
    }),
  }));
  const span = {
    traceId: opts.traceId || traceIdFor(rec.id),
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
      ...obsAttributes(o),
    }),
    ...(events.length ? { events } : {}),
    // The status message is the stable error code when there is one: upstream error text
    // is not exported.
    status: rec.error_class
      ? (() => {
          const message = o?.error?.code || rec.error_message;
          return { code: STATUS_CODE_ERROR, ...(message ? { message: String(message) } : {}) };
        })()
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
  traceIdFor,
  obsAttributes,
};
