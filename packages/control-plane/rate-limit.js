"use strict";

/**
 * Sliding-window RPM / TPM limiter for control-plane admission.
 * In-memory by default; injectable clock for tests.
 * LiteLLM has virtual-key rate limits — we enforce at the compress→route gateway.
 */

function nowMs(clock) {
  return typeof clock === "function" ? clock() : Date.now();
}

/**
 * @param {{ windowMs?: number, clock?: () => number }} [options]
 */
function createRateLimitStore(options = {}) {
  const windowMs = Math.max(1000, Number(options.windowMs) || 60_000);
  const clock = options.clock;
  /** @type {Map<string, { ts: number, tokens: number }[]>} */
  const buckets = new Map();

  function prune(key, now) {
    const arr = buckets.get(key) || [];
    const kept = arr.filter((e) => now - e.ts < windowMs);
    buckets.set(key, kept);
    return kept;
  }

  function snapshot(key) {
    const now = nowMs(clock);
    const arr = prune(key, now);
    const rpm_used = arr.length;
    const tpm_used = arr.reduce((s, e) => s + (Number(e.tokens) || 0), 0);
    return { rpm_used, tpm_used, window_ms: windowMs };
  }

  /**
   * Check without recording.
   */
  function check(key, policy = {}) {
    const snap = snapshot(key);
    const reasons = [];
    let allow = true;
    if (policy.rpm != null && snap.rpm_used >= Number(policy.rpm)) {
      allow = false;
      reasons.push("rpm_exceeded");
    }
    if (policy.tpm != null && snap.tpm_used >= Number(policy.tpm)) {
      allow = false;
      reasons.push("tpm_exceeded");
    }
    if (allow) reasons.push("ok");
    return { allow, reasons, ...snap };
  }

  /**
   * Record a request (call after admission allow).
   * @param {string} key — org/key/agent composite
   * @param {number} [tokens] — estimated prompt tokens for TPM
   */
  function record(key, tokens = 0) {
    const now = nowMs(clock);
    const arr = prune(key, now);
    arr.push({ ts: now, tokens: Math.max(0, Number(tokens) || 0) });
    buckets.set(key, arr);
    return snapshot(key);
  }

  /**
   * Atomic check-then-record. Fail closed on exceed.
   */
  function consume(key, policy = {}, tokens = 0) {
    const before = check(key, policy);
    if (!before.allow) return { ...before, recorded: false };
    // TPM: also reject if this request alone would blow the window
    if (
      policy.tpm != null &&
      before.tpm_used + Math.max(0, Number(tokens) || 0) > Number(policy.tpm)
    ) {
      return {
        allow: false,
        reasons: ["tpm_exceeded"],
        rpm_used: before.rpm_used,
        tpm_used: before.tpm_used,
        window_ms: windowMs,
        recorded: false,
      };
    }
    const after = record(key, tokens);
    return { allow: true, reasons: ["ok"], ...after, recorded: true };
  }

  function clear() {
    buckets.clear();
  }

  return { check, record, consume, snapshot, clear, windowMs };
}

function rateLimitKey(parts = {}) {
  return ["rl", parts.org_id || "-", parts.key_id || "-", parts.agent_id || "-"].join(":");
}

module.exports = {
  createRateLimitStore,
  rateLimitKey,
};
