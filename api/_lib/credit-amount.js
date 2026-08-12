/**
 * Paid credit math — never trust Checkout metadata for dollars credited.
 * Metadata is attacker/operator-editable relative to what Stripe actually charged;
 * amount_total / PaymentIntent.amount is the source of truth.
 */
const { roundUsd, MIN_CREDIT_LIMIT_USD, MAX_CREDIT_LIMIT_USD } = require("./stripe");

/**
 * USD actually charged on a Checkout session or synthetic PI session.
 * @returns {number|null} null when amount unknown
 */
function paidCreditUsdFromSession(session) {
  if (!session || typeof session !== "object") return null;
  if (session.amount_total != null && Number.isFinite(Number(session.amount_total))) {
    return roundUsd(Number(session.amount_total) / 100);
  }
  if (session.amount != null && Number.isFinite(Number(session.amount))) {
    return roundUsd(Number(session.amount) / 100);
  }
  return null;
}

/**
 * Whether a paid amount is eligible to grant prepaid wallet credit.
 * $0 (100% promo) and unknown amounts must not mint free credits.
 */
function isCreditablePaidUsd(usd) {
  if (usd == null || !Number.isFinite(Number(usd))) return false;
  const n = Number(usd);
  return n > 0 && n <= MAX_CREDIT_LIMIT_USD * 2;
}

/**
 * Auto-recharge / checkout pack size only — clamps to product min/max.
 * Do NOT use for applying credits after payment.
 */
function clampPackUsd(raw, fallback = MIN_CREDIT_LIMIT_USD) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n * 100) / 100;
  return Math.min(MAX_CREDIT_LIMIT_USD, Math.max(MIN_CREDIT_LIMIT_USD, rounded));
}

module.exports = {
  paidCreditUsdFromSession,
  isCreditablePaidUsd,
  clampPackUsd,
};
