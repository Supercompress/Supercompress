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
  if (!unlimited && remaining === 0) {
    response.warnings = [...new Set([
      ...(response.warnings || []),
      "Free token allowance is exhausted. Further compression is subject to account billing settings. Review billing: https://www.supercompress.dev/dashboard#billing",
    ])];
  }
  return response;
}

module.exports = { attachCompressionQuota };
