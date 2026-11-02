"use strict";

/**
 * Control-plane gateway billing: model spend is paid from the account's SuperCompress
 * prepaid credit balance (the same balance /v1/compress burns), not from a separate wallet.
 *
 *   hold(uid, usd)    — before the provider call; fails 402 when the account has no credit
 *                       or has reached its daily cap. Holds are tracked in-process so
 *                       concurrent requests cannot spend the same dollars twice.
 *   settle(id, usd)   — after the response; debits min(actual, remaining balance) from
 *                       sc_credit_balance_usd and adds it to today's spend (sc_cp_day).
 *   release(id)       — on any failure before settle; nothing is charged.
 *
 * Production billing runs on Auth custom claims (Firestore off). When the Firestore ledger
 * is the source of truth this bridge refuses to run rather than desync two balances.
 * Single-machine assumption: holds live in this process (the gateway runs one machine).
 */

const crypto = require("crypto");

const DEFAULT_DAILY_CAP_USD = 25;
const MIN_HOLD_USD = 0.000001;
const BILLING_URL = "https://www.supercompress.dev/dashboard#billing";

function roundUsd(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function billingErr(code, message, status) {
  const err = new Error(message || code);
  err.code = code;
  err.status = status;
  return err;
}

function dailyCapUsd(claims, env = process.env) {
  const own = Number(claims?.sc_cp_daily_cap_usd);
  if (Number.isFinite(own) && own >= 0) return own;
  const envCap = Number(env.SC_CP_DAILY_CAP_USD);
  return Number.isFinite(envCap) && envCap >= 0 ? envCap : DEFAULT_DAILY_CAP_USD;
}

function daySpendUsd(claims, today = dayKey()) {
  const row = claims?.sc_cp_day;
  return row && row.d === today ? Number(row.u) || 0 : 0;
}

/**
 * @param {object} [deps]
 * @param {(uid: string) => Promise<object>} [deps.getClaims]
 * @param {(uid: string, mutator: (claims: object) => object) => Promise<object>} [deps.patchClaims]
 * @param {() => boolean} [deps.claimsLedger] — true when claims are the billing source of truth
 * @param {object} [deps.env]
 */
function createCreditBilling(deps = {}) {
  const env = deps.env || process.env;
  const getClaims =
    deps.getClaims ||
    (async (uid) => {
      const { initFirebaseAdmin } = require("./auth");
      if (!initFirebaseAdmin()) throw billingErr("billing_unavailable", "Billing unavailable", 503);
      const admin = require("firebase-admin");
      const user = await admin.auth().getUser(uid);
      return user.customClaims || {};
    });
  const patchClaims =
    deps.patchClaims ||
    ((uid, mutator) => require("./billing-ledger").patchUserClaims(uid, mutator));
  const claimsLedger =
    deps.claimsLedger || (() => require("./firebase-off").skipFirestore());

  const holds = new Map();

  function outstanding(uid) {
    let sum = 0;
    for (const h of holds.values()) if (h.uid === uid) sum += h.amount_usd;
    return sum;
  }

  async function hold(uid, amountUsd) {
    if (!uid) throw billingErr("auth_required", "auth_required", 401);
    if (!claimsLedger()) {
      throw billingErr("billing_unavailable", "Gateway billing needs the claims ledger", 503);
    }
    let claims;
    try {
      claims = await getClaims(uid);
    } catch (err) {
      throw billingErr("billing_unavailable", "Billing unavailable", 503);
    }
    const pending = outstanding(uid);
    const available = roundUsd((Number(claims.sc_credit_balance_usd) || 0) - pending);
    if (available <= MIN_HOLD_USD) {
      throw billingErr(
        "credits_required",
        `Model calls through the gateway are paid from prepaid credits. Add credits: ${BILLING_URL}`,
        402
      );
    }
    const capLeft = roundUsd(dailyCapUsd(claims, env) - daySpendUsd(claims) - pending);
    if (capLeft <= MIN_HOLD_USD) {
      throw billingErr("daily_cap_reached", "Daily gateway spend cap reached for this account", 402);
    }
    const amount = roundUsd(Math.min(Math.max(Number(amountUsd) || 0, MIN_HOLD_USD), available, capLeft));
    const id = `hold_${crypto.randomBytes(8).toString("hex")}`;
    holds.set(id, { uid, amount_usd: amount, at: Date.now() });
    return { id, amount_usd: amount };
  }

  async function settle(id, actualUsd) {
    const h = holds.get(id);
    if (!h) return { charged_usd: 0, already: true };
    holds.delete(id);
    const want = roundUsd(Math.max(0, Number(actualUsd) || 0));
    if (!(want > 0)) return { charged_usd: 0 };
    let charged = 0;
    const today = dayKey();
    await patchClaims(h.uid, (live) => {
      const balance = Number(live.sc_credit_balance_usd) || 0;
      charged = roundUsd(Math.min(want, Math.max(0, balance)));
      return {
        ...live,
        sc_credit_balance_usd: roundUsd(balance - charged),
        sc_cp_day: { d: today, u: roundUsd(daySpendUsd(live, today) + charged) },
      };
    });
    return { charged_usd: charged };
  }

  async function release(id) {
    holds.delete(id);
  }

  return { hold, settle, release, outstanding, _holds: holds };
}

let _billing = null;
function processCreditBilling() {
  if (!_billing) _billing = createCreditBilling();
  return _billing;
}

module.exports = {
  createCreditBilling,
  processCreditBilling,
  dailyCapUsd,
  daySpendUsd,
  DEFAULT_DAILY_CAP_USD,
};
