const DEFAULT_UPGRADE_URL = "https://www.supercompress.dev/dashboard#billing";

function httpsUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

function paywallError(status, body) {
  if (status !== 402 && !/PAYWALL|free_quota_exhausted|credits_exhausted/i.test(body)) return null;
  let checkoutUrl = "";
  let upgradeUrl = DEFAULT_UPGRADE_URL;
  try {
    const parsed = JSON.parse(body || "{}");
    checkoutUrl = httpsUrl(parsed.checkout_url);
    upgradeUrl = checkoutUrl || httpsUrl(parsed.upgrade_url) || upgradeUrl;
  } catch {
    const match = String(body || "").match(/https:\/\/checkout\.stripe\.com\/[^\s"'<>]+/);
    if (match) checkoutUrl = httpsUrl(match[0]);
    upgradeUrl = checkoutUrl || upgradeUrl;
  }
  const error = new Error(checkoutUrl
    ? `PAYWALL: Auto-recharge needs confirmation. Open ${upgradeUrl}, then retry.`
    : `PAYWALL: This request exceeds your remaining free tokens or credits. Add credits at ${upgradeUrl} — $0.10/1M after free ($10 min), then retry.`);
  error.status = 402;
  error.paywall = true;
  error.upgrade_url = upgradeUrl;
  error.checkout_url = checkoutUrl || null;
  return error;
}

module.exports = { paywallError };
