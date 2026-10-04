"use strict";

/**
 * Provider / model health circuit breaker.
 * Failures trip degraded → down; successes close the circuit.
 * Feeds the router health map so fallbacks skip hot failures (LiteLLM-parity, compress-aware path).
 */

function nowMs(clock) {
  return typeof clock === "function" ? clock() : Date.now();
}

/**
 * @param {{
 *   failureThreshold?: number,
 *   successThreshold?: number,
 *   cooldownMs?: number,
 *   clock?: () => number,
 * }} [options]
 */
function createHealthTracker(options = {}) {
  const failureThreshold = Math.max(1, Number(options.failureThreshold) || 3);
  const successThreshold = Math.max(1, Number(options.successThreshold) || 2);
  const cooldownMs = Math.max(
    1,
    options.cooldownMs != null ? Number(options.cooldownMs) : 30_000
  );
  const clock = options.clock;

  /** @type {Map<string, { failures: number, successes: number, state: string, opened_at: number|null }>} */
  const models = new Map();

  function ensure(id) {
    const key = String(id);
    if (!models.has(key)) {
      models.set(key, { failures: 0, successes: 0, state: "up", opened_at: null });
    }
    return models.get(key);
  }

  function maybeRecover(rec, now) {
    if (rec.state === "down" && rec.opened_at != null && now - rec.opened_at >= cooldownMs) {
      rec.state = "degraded";
      rec.failures = 0;
      rec.successes = 0;
    }
  }

  function recordSuccess(modelId) {
    const rec = ensure(modelId);
    const now = nowMs(clock);
    maybeRecover(rec, now);
    rec.successes += 1;
    rec.failures = 0;
    if (rec.state === "degraded" && rec.successes >= successThreshold) {
      rec.state = "up";
      rec.opened_at = null;
      rec.successes = 0;
    } else if (rec.state === "up") {
      rec.successes = 0;
    }
    return get(modelId);
  }

  function recordFailure(modelId) {
    const rec = ensure(modelId);
    const now = nowMs(clock);
    maybeRecover(rec, now);
    rec.failures += 1;
    rec.successes = 0;
    if (rec.failures >= failureThreshold) {
      rec.state = "down";
      rec.opened_at = now;
      rec.failures = 0;
    } else if (rec.state === "up") {
      rec.state = "degraded";
    }
    return get(modelId);
  }

  function get(modelId) {
    const rec = ensure(modelId);
    maybeRecover(rec, nowMs(clock));
    return {
      model: String(modelId),
      health: rec.state,
      failures: rec.failures,
      successes: rec.successes,
      opened_at: rec.opened_at,
    };
  }

  /** Snapshot for router `health` input: { modelId: "up"|"degraded"|"down" } */
  function healthMap() {
    const now = nowMs(clock);
    const out = {};
    for (const [id, rec] of models) {
      maybeRecover(rec, now);
      out[id] = rec.state;
    }
    return out;
  }

  function clear() {
    models.clear();
  }

  return {
    recordSuccess,
    recordFailure,
    get,
    healthMap,
    clear,
    failureThreshold,
    successThreshold,
    cooldownMs,
  };
}

module.exports = { createHealthTracker };
