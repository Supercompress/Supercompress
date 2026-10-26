const BILLING_URL = "https://www.supercompress.dev/dashboard#billing";

function responseMetadata(body = {}) {
  const metadata = {};
  for (const key of [
    "warnings", "skip_reason", "mode", "fallback_reason", "compression_safety", "compressed_applied", "compression_applied",
    "free_tokens_remaining", "free_tokens_per_month", "tokens_used_this_period",
    "tokens_remaining", "limit_reached", "unlimited", "payg_enabled", "credit_wallet",
    "credit_balance_usd", "auto_recharge", "upgrade_url", "code", "notice", "detail", "paywall",
    "passthrough", "passthrough_reason", "billed", "query_mode", "compression_warning", "quota", "quota_warning",
  ]) {
    if (body[key] !== undefined) metadata[key] = body[key];
  }
  const warnings = Array.isArray(body.warnings) ? [...body.warnings] : [];
  for (const warning of [body.compression_warning, body.quota_warning]) {
    if (typeof warning === "string" && warning) warnings.push(warning);
  }
  const billing = typeof body.upgrade_url === "string" && body.upgrade_url ? body.upgrade_url : BILLING_URL;
  const remaining = body.free_tokens_remaining;
  const balance = body.credit_balance_usd;
  if (body.code === "credits_exhausted") {
    warnings.push(`Prepaid credit is insufficient for this request. Review billing: ${billing}`);
  } else if (body.credit_wallet === true && typeof balance === "number" && Number.isFinite(balance) && balance <= 0 && body.unlimited !== true) {
    warnings.push(`Prepaid balance is $${balance}; compression may require a top-up. Review billing: ${billing}`);
  }
  if (body.unlimited !== true && typeof remaining === "number" && Number.isFinite(remaining) && remaining >= 0) {
    if (remaining > 0) {
      warnings.push(`Quota: ${remaining} free tokens remaining this period.`);
    } else {
      const prepaid = body.credit_wallet === true && typeof balance === "number" && Number.isFinite(balance) && balance > 0
        ? ` Prepaid balance: $${balance}; further usage is subject to billing.`
        : body.payg_enabled === true ? " Further usage is subject to your account billing settings." : "";
      warnings.push(`Free token allowance is exhausted.${prepaid} Review billing: ${billing}`);
    }
  } else if (body.code === "free_quota_exhausted" || (body.limit_reached === true && body.unlimited !== true)) {
    warnings.push(`Free token quota cannot cover this request. Review billing: ${billing}`);
  }
  if (warnings.length) metadata.warnings = [...new Set(warnings)];
  return metadata;
}

function responseError(body = {}, fallback) {
  const metadata = responseMetadata(body);
  const warnings = (metadata.warnings || []).map(warning => typeof warning === "string" ? warning : JSON.stringify(warning));
  const primary = [body.detail, body.notice, body.message].filter(Boolean);
  const messages = [...(primary.length ? primary : [fallback]), ...warnings];
  if (body.paywall || body.code === "free_quota_exhausted" || body.code === "credits_exhausted") {
    messages.push(`Review billing: ${body.upgrade_url || BILLING_URL}`);
  }
  return [...new Set(messages)].join("\n");
}

module.exports = { responseMetadata, responseError };
