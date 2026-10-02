"use strict";

const { flags } = require("../../packages/control-plane/flags");
const { createLedgerStore } = require("../../packages/control-plane/ledger");
const { traceFromCompressResult } = require("../../packages/control-plane/compression-trace");

/** Process-local ledger when SC_CP_LEDGER=1 (no Firestore yet). */
let _ledger = null;
function getProcessLedger() {
  if (!_ledger) _ledger = createLedgerStore();
  return _ledger;
}

/**
 * Optional hook after compress succeeds.
 * - SC_CP_TRACE=1 → attach compression_trace on payload (additive)
 * - SC_CP_LEDGER=1 → write a finalized request row with the trace
 * Never includes query/ask text in the trace.
 */
function maybeAttachControlPlane(result, meta = {}) {
  const f = flags();
  if (!f.trace && !f.ledger) return result;

  const compression = traceFromCompressResult(result, {
    strategy: meta.strategy,
    skip_reason: meta.skip_reason,
    confidence: meta.confidence,
  });

  const out = result && typeof result === "object" ? result : {};
  if (f.trace) {
    out.compression_trace = compression;
  }

  if (f.ledger) {
    const ledger = getProcessLedger();
    const rec = ledger.create({
      org_id: meta.org_id,
      key_id: meta.key_id,
      agent_id: meta.agent_id,
      idempotency_key: meta.idempotency_key,
      model_requested: meta.model,
      compression,
    });
    ledger.transition(rec.id, "compressed", { compression });
    ledger.finalize(rec.id, {
      compression,
      latency_ms: meta.latency_ms,
      actual_usd: meta.actual_usd,
    });
    out.sc_request_id = rec.id;
  }

  return out;
}

module.exports = {
  maybeAttachControlPlane,
  getProcessLedger,
  flags,
};
