/**
 * Transactional billing ledger — source of truth for monthly usage + prepaid balance.
 *
 * Auth custom claims (`sc_usage`, `sc_credit_balance_usd`) are mirrored after
 * commit for dashboard/compat reads, but concurrent compressions must not
 * read-modify-write claims directly.
 *
 * Firestore doc: billing/{uid}
 */
const admin = require("firebase-admin");
const { initFirebaseAdmin } = require("./auth");
const {
  FREE_TOKENS_PER_MONTH,
  USD_PER_MILLION,
  billableTokens,
  roundUsd,
  normalizeCreditLimitUsd,
  DEFAULT_CREDIT_LIMIT_USD,
  isComped,
  isLegacyMetered,
  isCreditWallet,
  isPaygEnabled,
} = require("./stripe");

const MICROS_PER_USD = 1_000_000;

let _db = null;
function db() {
  if (!_db) {
    initFirebaseAdmin();
    _db = admin.firestore();
  }
  return _db;
}

function monthKey(d = new Date()) {
  return d.toISOString().slice(0, 7);
}

function usdToMicros(usd) {
  return Math.round(Number(usd || 0) * MICROS_PER_USD);
}

function microsToUsd(micros) {
  return Math.round(Number(micros || 0)) / MICROS_PER_USD;
}

/** Integer micro-USD for a token count at $0.30 / 1M (no per-request $0 rounding). */
function tokensToMicros(tokenCount) {
  // tokens * 0.30 micros/token  (== tokens/1e6 * 0.30 * 1e6)
  return Math.ceil(Number(tokenCount || 0) * USD_PER_MILLION);
}

function emptyLedger(claims = {}) {
  const month = monthKey();
  const claimUsage = claims.sc_usage?.month === month ? claims.sc_usage : {};
  return {
    month,
    tokens_in: Number(claimUsage.tokens_in || 0),
    tokens_out: Number(claimUsage.tokens_out || 0),
    tokens_saved: Number(claimUsage.tokens_saved || 0),
    requests: Number(claimUsage.requests || 0),
    tokens_reported: Number(claimUsage.tokens_reported || 0),
    credit_balance_micros: usdToMicros(claims.sc_credit_balance_usd || 0),
    credit_limit_usd: normalizeCreditLimitUsd(
      claims.sc_credit_limit_usd,
      DEFAULT_CREDIT_LIMIT_USD
    ),
    auto_recharge: Boolean(claims.sc_auto_recharge),
    customer_id: claims.sc_customer_id || null,
    credited_keys: Array.isArray(claims.sc_credited_sessions)
      ? claims.sc_credited_sessions.slice(-40)
      : [],
    updated_at: new Date().toISOString(),
  };
}

function normalizeLedger(raw, claims = {}) {
  const base = emptyLedger(claims);
  if (!raw || typeof raw !== "object") return base;
  const month = monthKey();
  // Month rollover
  if (raw.month && raw.month !== month) {
    return {
      ...base,
      credit_balance_micros:
        raw.credit_balance_micros != null
          ? Number(raw.credit_balance_micros)
          : base.credit_balance_micros,
      credit_limit_usd:
        raw.credit_limit_usd != null
          ? normalizeCreditLimitUsd(raw.credit_limit_usd)
          : base.credit_limit_usd,
      auto_recharge: raw.auto_recharge != null ? Boolean(raw.auto_recharge) : base.auto_recharge,
      customer_id: raw.customer_id || base.customer_id,
      credited_keys: Array.isArray(raw.credited_keys) ? raw.credited_keys.slice(-40) : base.credited_keys,
    };
  }
  return {
    month,
    tokens_in: Number(raw.tokens_in || 0),
    tokens_out: Number(raw.tokens_out || 0),
    tokens_saved: Number(raw.tokens_saved || 0),
    requests: Number(raw.requests || 0),
    tokens_reported: Number(raw.tokens_reported || 0),
    credit_balance_micros:
      raw.credit_balance_micros != null
        ? Number(raw.credit_balance_micros)
        : usdToMicros(claims.sc_credit_balance_usd || 0),
    credit_limit_usd: normalizeCreditLimitUsd(
      raw.credit_limit_usd ?? claims.sc_credit_limit_usd,
      DEFAULT_CREDIT_LIMIT_USD
    ),
    auto_recharge:
      raw.auto_recharge != null ? Boolean(raw.auto_recharge) : Boolean(claims.sc_auto_recharge),
    customer_id: raw.customer_id || claims.sc_customer_id || null,
    credited_keys: Array.isArray(raw.credited_keys)
      ? raw.credited_keys.slice(-40)
      : base.credited_keys,
    updated_at: raw.updated_at || new Date().toISOString(),
  };
}

async function loadLedger(uid, claims = {}) {
  if (!uid || !initFirebaseAdmin()) return emptyLedger(claims);
  try {
    const snap = await db().collection("billing").doc(uid).get();
    return normalizeLedger(snap.exists ? snap.data() : null, claims);
  } catch (err) {
    console.warn("billing-ledger load failed:", err.message || err);
    return emptyLedger(claims);
  }
}

async function mirrorClaims(uid, ledger, claimsBase = {}) {
  if (!uid || !initFirebaseAdmin()) return;
  try {
    const fresh = await admin.auth().getUser(uid);
    const prev = { ...(fresh.customClaims || {}), ...claimsBase };
    await admin.auth().setCustomUserClaims(uid, {
      ...prev,
      sc_usage: {
        month: ledger.month,
        requests: ledger.requests,
        tokens_in: ledger.tokens_in,
        tokens_out: ledger.tokens_out,
        tokens_saved: ledger.tokens_saved,
        tokens_reported: ledger.tokens_reported,
      },
      sc_credit_balance_usd: roundUsd(microsToUsd(ledger.credit_balance_micros)),
      ...(ledger.credit_limit_usd != null
        ? { sc_credit_limit_usd: ledger.credit_limit_usd }
        : {}),
      ...(ledger.auto_recharge != null ? { sc_auto_recharge: ledger.auto_recharge } : {}),
      ...(ledger.customer_id ? { sc_customer_id: ledger.customer_id } : {}),
    });
  } catch (err) {
    console.warn("billing-ledger claim mirror failed:", err.message || err);
  }
}

/**
 * Atomically record usage and burn prepaid credit for newly billable tokens.
 * Returns updated ledger snapshot + burn metadata.
 */
async function applyUsageAndBurn({ uid, tokensIn, tokensOut, tokensSaved, claims = {} }) {
  if (!uid) throw new Error("uid required");
  if (!initFirebaseAdmin()) {
    // Soft fallback — caller may still update claims (legacy path).
    const ledger = emptyLedger(claims);
    ledger.tokens_in += tokensIn;
    ledger.tokens_out += tokensOut;
    ledger.tokens_saved += tokensSaved;
    ledger.requests += 1;
    return { ledger, burned_micros: 0, fallback: true };
  }

  const ref = db().collection("billing").doc(uid);
  const result = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const ledger = normalizeLedger(snap.exists ? snap.data() : null, claims);
    const prevTokensIn = ledger.tokens_in;
    ledger.tokens_in += Math.max(0, Number(tokensIn) || 0);
    ledger.tokens_out += Math.max(0, Number(tokensOut) || 0);
    ledger.tokens_saved += Math.max(0, Number(tokensSaved) || 0);
    ledger.requests += 1;
    ledger.updated_at = new Date().toISOString();

    let burned_micros = 0;
    const wallet =
      !isComped(claims) &&
      (isCreditWallet(claims) ||
        (isPaygEnabled(claims.sc_plan) && !isLegacyMetered(claims)));
    if (wallet) {
      const prevBillable = billableTokens(prevTokensIn);
      const newBillable = billableTokens(ledger.tokens_in);
      const deltaBillable = Math.max(0, newBillable - prevBillable);
      burned_micros = tokensToMicros(deltaBillable);
      if (burned_micros > 0) {
        ledger.credit_balance_micros = Math.max(
          0,
          Number(ledger.credit_balance_micros || 0) - burned_micros
        );
      }
    }

    tx.set(ref, ledger, { merge: true });
    return { ledger, burned_micros };
  });

  await mirrorClaims(uid, result.ledger, claims);
  return result;
}

/**
 * Credit prepaid balance (Checkout / auto-recharge). Idempotent by creditKey.
 */
async function creditBalance({ uid, creditUsd, creditKey, claims = {}, patch = {} }) {
  if (!uid || !creditKey) return { applied: false, reason: "missing_args" };
  if (!initFirebaseAdmin()) return { applied: false, reason: "firebase_unavailable" };

  const ref = db().collection("billing").doc(uid);
  const result = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const ledger = normalizeLedger(snap.exists ? snap.data() : null, claims);
    const keys = Array.isArray(ledger.credited_keys) ? ledger.credited_keys : [];
    if (keys.includes(creditKey)) {
      return {
        applied: true,
        already: true,
        ledger,
        balance: roundUsd(microsToUsd(ledger.credit_balance_micros)),
      };
    }
    const add = usdToMicros(creditUsd);
    ledger.credit_balance_micros = Number(ledger.credit_balance_micros || 0) + add;
    if (patch.credit_limit_usd != null) {
      ledger.credit_limit_usd = normalizeCreditLimitUsd(patch.credit_limit_usd);
    }
    if (patch.auto_recharge != null) ledger.auto_recharge = Boolean(patch.auto_recharge);
    if (patch.customer_id) ledger.customer_id = patch.customer_id;
    ledger.credited_keys = [...keys.slice(-40), creditKey];
    ledger.updated_at = new Date().toISOString();
    tx.set(ref, ledger, { merge: true });
    return {
      applied: true,
      already: false,
      ledger,
      balance: roundUsd(microsToUsd(ledger.credit_balance_micros)),
    };
  });

  await mirrorClaims(uid, result.ledger, {
    ...claims,
    sc_plan: "payg",
    sc_metered: false,
    sc_credited_sessions: result.ledger.credited_keys,
  });
  return result;
}

/**
 * Distributed lock for auto-recharge. Returns { acquired, release }.
 * Lock TTL ~90s; held across Stripe PaymentIntent confirm.
 */
async function acquireRechargeLock(uid) {
  if (!uid || !initFirebaseAdmin()) return { acquired: false, reason: "unavailable" };
  const ref = db().collection("billing_locks").doc(uid);
  const now = Date.now();
  const until = now + 90_000;
  try {
    const acquired = await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : null;
      if (data?.until && Number(data.until) > now && data.kind === "recharge") {
        return false;
      }
      tx.set(ref, { kind: "recharge", until, updated_at: new Date().toISOString() });
      return true;
    });
    return {
      acquired,
      async release() {
        try {
          await ref.delete();
        } catch {}
      },
    };
  } catch (err) {
    console.warn("recharge lock failed:", err.message || err);
    return { acquired: false, reason: err.message };
  }
}

async function markTokensReported(uid, tokensReported, claims = {}) {
  if (!uid || !initFirebaseAdmin()) return null;
  const ref = db().collection("billing").doc(uid);
  const ledger = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const next = normalizeLedger(snap.exists ? snap.data() : null, claims);
    next.tokens_reported = Math.max(Number(next.tokens_reported || 0), Number(tokensReported || 0));
    next.updated_at = new Date().toISOString();
    tx.set(ref, next, { merge: true });
    return next;
  });
  await mirrorClaims(uid, ledger, claims);
  return ledger;
}

module.exports = {
  loadLedger,
  applyUsageAndBurn,
  creditBalance,
  acquireRechargeLock,
  markTokensReported,
  mirrorClaims,
  tokensToMicros,
  usdToMicros,
  microsToUsd,
  monthKey,
  FREE_TOKENS_PER_MONTH,
};
