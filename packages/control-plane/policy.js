"use strict";

/**
 * Config-first admission / policy evaluator (v0).
 */

function normalizePolicy(raw = {}) {
  return {
    version: Number(raw.version) === 1 || raw.version == null ? 1 : Number(raw.version),
    compress_default: raw.compress_default !== false,
    max_usd_per_request:
      raw.max_usd_per_request != null ? Number(raw.max_usd_per_request) : undefined,
    max_usd_per_day: raw.max_usd_per_day != null ? Number(raw.max_usd_per_day) : undefined,
    rpm: raw.rpm != null ? Number(raw.rpm) : undefined,
    tpm: raw.tpm != null ? Number(raw.tpm) : undefined,
    allow_models: Array.isArray(raw.allow_models) ? raw.allow_models.map(String) : undefined,
    deny_models: Array.isArray(raw.deny_models) ? raw.deny_models.map(String) : undefined,
    routing:
      raw.routing && typeof raw.routing === "object"
        ? {
            strategy: raw.routing.strategy,
            prefer: Array.isArray(raw.routing.prefer) ? raw.routing.prefer.map(String) : undefined,
            fallbacks: Array.isArray(raw.routing.fallbacks)
              ? raw.routing.fallbacks.map(String)
              : undefined,
            max_retries:
              raw.routing.max_retries != null ? Number(raw.routing.max_retries) : undefined,
            require_capabilities: Array.isArray(raw.routing.require_capabilities)
              ? raw.routing.require_capabilities.map(String)
              : undefined,
            output_tokens_reserve:
              raw.routing.output_tokens_reserve != null
                ? Number(raw.routing.output_tokens_reserve)
                : undefined,
          }
        : undefined,
  };
}

/**
 * @param {object} policy
 * @param {object} meta — { model, estimated_usd, rpm_used, tpm_used, day_spend_usd, sc_compress }
 */
function evaluateAdmission(policyInput, meta = {}) {
  const policy = normalizePolicy(policyInput || {});
  const reasons = [];
  let allow = true;

  const model = meta.model != null ? String(meta.model) : null;
  if (model && policy.deny_models?.length && policy.deny_models.includes(model)) {
    allow = false;
    reasons.push(`model_denied:${model}`);
  }
  if (model && policy.allow_models?.length && !policy.allow_models.includes(model)) {
    allow = false;
    reasons.push(`model_not_allowed:${model}`);
  }

  const estimated =
    meta.estimated_usd != null && Number.isFinite(Number(meta.estimated_usd))
      ? Number(meta.estimated_usd)
      : meta.estimated_max_usd != null
        ? Number(meta.estimated_max_usd)
        : undefined;

  if (
    estimated != null &&
    policy.max_usd_per_request != null &&
    estimated > policy.max_usd_per_request
  ) {
    allow = false;
    reasons.push(`max_usd_per_request:${estimated}>${policy.max_usd_per_request}`);
  }

  if (
    meta.day_spend_usd != null &&
    policy.max_usd_per_day != null &&
    Number(meta.day_spend_usd) + (estimated || 0) > policy.max_usd_per_day
  ) {
    allow = false;
    reasons.push("max_usd_per_day");
  }

  if (policy.rpm != null && meta.rpm_used != null && Number(meta.rpm_used) >= policy.rpm) {
    allow = false;
    reasons.push("rpm_exceeded");
  }
  if (policy.tpm != null && meta.tpm_used != null && Number(meta.tpm_used) >= policy.tpm) {
    allow = false;
    reasons.push("tpm_exceeded");
  }

  if (allow) reasons.push("ok");

  const estimated_max_usd =
    estimated != null
      ? estimated
      : policy.max_usd_per_request != null
        ? policy.max_usd_per_request
        : undefined;

  return {
    allow,
    reasons,
    estimated_max_usd,
    policy_version: policy.version,
    compress_default: policy.compress_default,
  };
}

module.exports = {
  normalizePolicy,
  evaluateAdmission,
};
