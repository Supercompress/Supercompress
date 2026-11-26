/**
 * New-customer offer: 50% off the first credit pack.
 *
 * Stripe always charges the full pack price, and the paid amount is what gets credited (see
 * credit-topup.js: never trust metadata). The discount is a one-time bonus that matches the
 * first payment, so $10 paid = $20 of usage. It is capped, and only granted when:
 *   - the account is at most WINDOW_DAYS old when that checkout starts,
 *   - the account has never been credited before and never had a first-pay bonus,
 *   - the account is not comped.
 * The ledger grants a first-pay bonus at most once per uid (billing_bonus/{uid}:first_pay or the
 * sc_first_pay_bonus_at claim), so concurrent checkouts cannot double it.
 *
 * Kill switch: SC_NEW_CUSTOMER_OFFER=0.
 */

const PERCENT_OFF = 50;
const WINDOW_DAYS = 7;
const MAX_BONUS_USD = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

function offerEnabled(env = process.env) {
  return String(env.SC_NEW_CUSTOMER_OFFER ?? "1").trim() !== "0";
}

function createdAtMs(owner) {
  const raw = owner?.metadata?.creationTime || owner?.metadata?.creation_time || owner?.created_at;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function hasPaidBefore(claims = {}) {
  if (claims.sc_first_pay_bonus_at) return true;
  if (Array.isArray(claims.sc_credited_sessions) && claims.sc_credited_sessions.length) return true;
  if (Number(claims.sc_credit_balance_usd || 0) > 0) return true;
  if (Array.isArray(claims.sc_recent_billing) && claims.sc_recent_billing.some((r) => Number(r.credit_usd || r.amount_usd || 0) > 0)) return true;
  return false;
}

/**
 * Offer status for an account at a point in time (ms). `at` is when the checkout started for
 * grants, and now for the dashboard.
 */
function newCustomerOffer(owner, { at = Date.now(), env = process.env } = {}) {
  const claims = owner?.customClaims || {};
  const created = createdAtMs(owner);
  const base = { percent_off: PERCENT_OFF, max_bonus_usd: MAX_BONUS_USD, window_days: WINDOW_DAYS };
  if (!offerEnabled(env)) return { ...base, eligible: false, reason: "disabled" };
  if (claims.sc_comped === true) return { ...base, eligible: false, reason: "comped" };
  if (hasPaidBefore(claims)) return { ...base, eligible: false, reason: "already_purchased" };
  if (created == null) return { ...base, eligible: false, reason: "unknown_signup_date" };
  const expires = created + WINDOW_DAYS * DAY_MS;
  if (at > expires) return { ...base, eligible: false, reason: "expired", expires_at: new Date(expires).toISOString() };
  return { ...base, eligible: true, reason: null, expires_at: new Date(expires).toISOString() };
}

/** Bonus credit (USD) for a first payment of `paidUsd`, or 0. */
function newCustomerBonusUsd(paidUsd, offer) {
  if (!offer?.eligible) return 0;
  const paid = Number(paidUsd);
  if (!Number.isFinite(paid) || paid <= 0) return 0;
  return Math.round(Math.min(paid, MAX_BONUS_USD) * 100) / 100;
}

module.exports = {
  PERCENT_OFF,
  WINDOW_DAYS,
  MAX_BONUS_USD,
  offerEnabled,
  newCustomerOffer,
  newCustomerBonusUsd,
};
