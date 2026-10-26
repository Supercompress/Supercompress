const { freeAllowance, isComped, isLegacyMetered, isPaygEnabled, isCreditWallet } = require("./stripe");

function attachCompressionQuota(response, owner, usage) {
  const claims = owner?.customClaims || {};
  const used = usage?.tokens_in;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return response;
  const unlimited = isComped(claims) || isLegacyMetered(claims);
  const allowance = freeAllowance(claims);
  const remaining = Math.max(0, allowance - used);
  Object.assign(response, {
    tokens_used_this_period: used,
    free_tokens_per_month: allowance,
    free_tokens_remaining: remaining,
    unlimited,
    payg_enabled: isPaygEnabled(claims.sc_plan),
    credit_wallet: isCreditWallet(claims),
  });
  if (typeof response.quota_warning === "string" && Array.isArray(response.warnings)) {
    response.warnings = response.warnings.filter(warning => warning !== response.quota_warning);
  }
  response.quota = {
    tokens_used_this_period: used,
    free_allowance: allowance,
    free_tokens_remaining: remaining,
    billing: unlimited ? "comped" : remaining > 0 ? "free" : "paid",
  };
  delete response.quota_warning;
  if (!unlimited && remaining === 0) {
    response.quota_warning = "Free token allowance is exhausted. Further compression is subject to account billing settings. Review billing: https://www.supercompress.dev/dashboard#billing";
  } else if (!unlimited && allowance > 0 && remaining <= allowance * 0.1) {
    response.quota_warning = `Free token allowance is nearly exhausted: ${remaining} tokens remain. Review billing: https://www.supercompress.dev/dashboard#billing`;
  }
  if (response.quota_warning) {
    response.quota.warning = response.quota_warning;
    response.warnings = [...new Set([
      ...(response.warnings || []),
      response.quota_warning,
    ])];
  }
  return response;
}

module.exports = { attachCompressionQuota };
