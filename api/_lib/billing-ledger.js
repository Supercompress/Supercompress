/**
 * Transactional billing ledger — source of truth for monthly usage + prepaid balance.
 *
 * Auth custom claims (`sc_usage`, `sc_credit_balance_usd`) are mirrored after
 * commit for dashboard/compat reads. Concurrent compressions must not
 * read-modify-write claims directly.
 *
 * Firestore:
 *   billing/{uid}                    — monthly usage + wallet balance
 *   billing_credits/{creditKey}      — permanent Stripe session / PI idempotency
 *   billing_usage/{uid}:{requestId}  — per-request usage burn + compress response replay
 *   billing_bonus/{uid}:first_pay    — one-time first-pay bonus create-once
 */
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

let _admin = null;
let _db = null;
function admin() {
  if (!_admin) _admin = require("firebase-admin");
  return _admin;
}
function db() {
  if (!_db) {
    initFirebaseAdmin();
    _db = admin().firestore();
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
  return Math.ceil(Number(tokenCount || 0) * USD_PER_MILLION);
}

function billingError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  if (Number.isFinite(Number(extra.status))) {
    err.status = Number(extra.status);
  } else if (code === "billing_unavailable") {
    err.status = 503;
  } else if (code === "idempotency_conflict") {
    err.status = 409;
  } else {
    err.status = 402;
  }
  err.paywall = code !== "billing_unavailable" && code !== "idempotency_conflict";
  Object.assign(err, extra);
  return err;
}

/**
 * SHA-256 fingerprint of billing-relevant compress request fields.
 * Used to bind Idempotency-Key / request_id to a specific payload.
 */
function computeCompressFingerprint(body = {}) {
  const crypto = require("crypto");
  const mode = String(body.mode || "compiler");
  const normalized = JSON.stringify({
    context: String(body.context || ""),
    query: String(body.query || "Summarize this context."),
    mode,
    budget_ratio: mode === "fixed" ? Number(body.budget_ratio ?? 0.35) : 0.35,
    ccr: body.ccr === true || body.ccr === "true",
    cache_prefix: body.cache_prefix === true || body.cache_prefix === "true",
  });
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/**
 * Decide whether an existing billing_usage row is a safe replay.
 * Throws idempotency_conflict (409) when the key is reused with a different payload.
 */
function assertUsageIdempotencyMatch(prev, { fingerprint, tokensIn, tokensOut, tokensSaved }) {
  if (!prev || typeof prev !== "object") return;
  const prevFp = String(prev.fingerprint || "").trim();
  const fp = String(fingerprint || "").trim();
  if (fp) {
    if (prevFp && prevFp !== fp) {
      throw billingError(
        "idempotency_conflict",
        "Idempotency-Key reused with a different request payload",
        { status: 409 }
      );
    }
    if (!prevFp) {
      // Legacy rows (pre-fingerprint): require identical billing token tuple.
      const same =
        Number(prev.tokens_in || 0) === Number(tokensIn || 0) &&
        Number(prev.tokens_out || 0) === Number(tokensOut || 0) &&
        Number(prev.tokens_saved || 0) === Number(tokensSaved || 0);
      if (!same) {
        throw billingError(
          "idempotency_conflict",
          "Idempotency-Key reused with a different request payload",
          { status: 409 }
        );
      }
    }
  }
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
    // Display-only recent keys; idempotency is billing_credits/{id}
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

/**
 * Pure gate used inside the Firestore transaction (and unit tests).
 * Rejects free-quota overshoot and wallet burns that exceed balance (no clamp-to-zero).
 */
function planUsageBurn(ledger, { tokensIn, tokensOut, tokensSaved, claims = {} }) {
  const prevTokensIn = Number(ledger.tokens_in || 0);
  const addIn = Math.max(0, Number(tokensIn) || 0);
  const addOut = Math.max(0, Number(tokensOut) || 0);
  const addSaved = Math.max(0, Number(tokensSaved) || 0);
  const nextTokensIn = prevTokensIn + addIn;

  const comped = isComped(claims);
  const legacy = isLegacyMetered(claims);
  const wallet =
    !comped &&
    (isCreditWallet(claims) ||
      (isPaygEnabled(claims.sc_plan) && !legacy));

  if (!comped && !legacy && !wallet) {
    if (prevTokensIn >= FREE_TOKENS_PER_MONTH || nextTokensIn > FREE_TOKENS_PER_MONTH) {
      throw billingError(
        "free_quota_exhausted",
        `Free ${FREE_TOKENS_PER_MONTH / 1e6}M token allowance exhausted this month.`,
        {
          payload: {
            ok: false,
            paywall: true,
            code: "free_quota_exhausted",
            tokens_used: prevTokensIn,
            free_tokens: FREE_TOKENS_PER_MONTH,
            upgrade_url: "https://www.supercompress.dev/dashboard#billing",
          },
        }
      );
    }
  }

  let burned_micros = 0;
  let nextBalance = Number(ledger.credit_balance_micros || 0);
  if (wallet) {
    const prevBillable = billableTokens(prevTokensIn);
    const newBillable = billableTokens(nextTokensIn);
    // Cumulative ceil so fractional micro-USD amortizes across requests
    // instead of ceil(delta * price) over-charging every tiny burn.
    burned_micros = Math.max(0, tokensToMicros(newBillable) - tokensToMicros(prevBillable));
    if (burned_micros > nextBalance) {
      throw billingError(
        "credits_exhausted",
        "Prepaid balance is insufficient for this compression.",
        {
          payload: {
            ok: false,
            paywall: true,
            code: "credits_exhausted",
            credit_balance_usd: roundUsd(microsToUsd(nextBalance)),
            required_usd: roundUsd(microsToUsd(burned_micros)),
            upgrade_url: "https://www.supercompress.dev/dashboard#billing",
          },
        }
      );
    }
    nextBalance -= burned_micros;
  }

  return {
    burned_micros,
    ledger: {
      ...ledger,
      tokens_in: nextTokensIn,
      tokens_out: Number(ledger.tokens_out || 0) + addOut,
      tokens_saved: Number(ledger.tokens_saved || 0) + addSaved,
      requests: Number(ledger.requests || 0) + 1,
      credit_balance_micros: nextBalance,
      updated_at: new Date().toISOString(),
    },
  };
}

function isFirestoreBackendDown(err) {
  if (!err) return false;
  const code = err.code;
  if (code === 7 || code === "7" || code === "SERVICE_DISABLED") return true;
  const msg = String(err.message || err || "");
  return /SERVICE_DISABLED|Cloud Firestore API has not been used|firestore\.googleapis\.com|PERMISSION_DENIED: Cloud Firestore/i.test(
    msg
  );
}

async function loadLedger(uid, claims = {}) {
  if (!uid || !initFirebaseAdmin()) {
    throw billingError("billing_unavailable", "Billing ledger unavailable");
  }
  try {
    const snap = await db().collection("billing").doc(uid).get();
    return normalizeLedger(snap.exists ? snap.data() : null, claims);
  } catch (err) {
    if (err.code === "billing_unavailable") throw err;
    console.warn("billing-ledger load failed — using Auth claims:", err.message || err);
    return normalizeLedger(null, claims);
  }
}

/**
 * When Cloud Firestore is disabled/unavailable, bill via Auth claims only.
 * Do not depend on gist here — gist rate limits caused the outage recovery path
 * to fail. Replay text is not stored (claims size); retries recompress but do
 * not double-bill (request id watermark on claims).
 */
async function applyUsageAndBurnClaimsFallback({
  uid,
  tokensIn,
  tokensOut,
  tokensSaved,
  claims = {},
  requestId,
  fingerprint,
  response = null,
}) {
  const rid = sanitizeRequestId(requestId);
  const fp = String(fingerprint || "").trim() || null;
  if (!rid) throw billingError("billing_unavailable", "Billing request id required");

  const fresh = await admin().auth().getUser(uid);
  const liveClaims = { ...(fresh.customClaims || {}), ...claims };
  const recent = Array.isArray(liveClaims.sc_recent_billing)
    ? liveClaims.sc_recent_billing
    : [];
  const prior = recent.find((r) => r && r.i === rid);
  if (prior) {
    assertUsageIdempotencyMatch(
      {
        fingerprint: prior.f || null,
        tokens_in: prior.tin,
        tokens_out: prior.tout,
        tokens_saved: prior.ts,
      },
      {
        fingerprint: fp,
        tokensIn,
        tokensOut,
        tokensSaved,
      }
    );
    return {
      burned_micros: Number(prior.b || 0),
      ledger: normalizeLedger(null, liveClaims),
      already: true,
      request_id: rid,
      fingerprint: prior.f || fp || null,
      response: null,
      backend: "claims-fallback",
    };
  }

  const ledger = normalizeLedger(null, liveClaims);
  const planned = planUsageBurn(ledger, { tokensIn, tokensOut, tokensSaved, claims: liveClaims });
  const nextRecent = [
    {
      i: rid.slice(0, 64),
      f: fp ? String(fp).slice(0, 32) : null,
      tin: Number(tokensIn) || 0,
      tout: Number(tokensOut) || 0,
      ts: Number(tokensSaved) || 0,
      b: planned.burned_micros,
      t: Date.now(),
    },
    ...recent,
  ].slice(0, 5);

  await admin().auth().setCustomUserClaims(uid, {
    ...liveClaims,
    sc_usage: {
      month: planned.ledger.month,
      requests: planned.ledger.requests,
      tokens_in: planned.ledger.tokens_in,
      tokens_out: planned.ledger.tokens_out,
      tokens_saved: planned.ledger.tokens_saved,
      tokens_reported: planned.ledger.tokens_reported || 0,
    },
    sc_credit_balance_usd: roundUsd(microsToUsd(planned.ledger.credit_balance_micros)),
    sc_recent_billing: nextRecent,
  });

  return {
    ...planned,
    already: false,
    request_id: rid,
    fingerprint: fp,
    response: sanitizeReplayResponse(response),
    backend: "claims-fallback",
  };
}

/**
 * Mirror only ledger-owned claim fields. Never re-apply a stale claimsBase over
 * fresher Auth state (plan / subscription / preferences from webhooks).
 */
async function mirrorClaims(uid, ledger) {
  if (!uid || !initFirebaseAdmin()) return;
  try {
    const fresh = await admin().auth().getUser(uid);
    const prev = { ...(fresh.customClaims || {}) };
    await admin().auth().setCustomUserClaims(uid, {
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
      ...(ledger.auto_recharge != null ? { sc_auto_recharge: Boolean(ledger.auto_recharge) } : {}),
      ...(ledger.customer_id ? { sc_customer_id: ledger.customer_id } : {}),
    });
  } catch (err) {
    console.warn("billing-ledger claim mirror failed:", err.message || err);
  }
}

/**
 * Sanitize client/server request ids for Firestore doc ids.
 * @returns {string|null}
 */
function sanitizeRequestId(raw) {
  const s = String(raw || "").trim();
  if (!s || s.length < 8 || s.length > 128) return null;
  if (!/^[\w.:-]+$/.test(s)) return null;
  return s;
}

/**
 * Atomically record usage and burn prepaid credit.
 * Idempotent via billing_usage/{uid}:{requestId} (create-once), bound to a
 * server-calculated request fingerprint so key reuse with a different payload
 * returns idempotency_conflict (409) instead of already:true.
 * Throws paywall / billing_unavailable — never silently under-charges.
 */
/** Cap stored replay payloads (Firestore 1 MiB doc limit; leave headroom). */
const MAX_REPLAY_TEXT_CHARS = 400_000;

function sanitizeReplayResponse(response) {
  if (!response || typeof response !== "object") return null;
  const text = String(response.compressed_text || "").slice(0, MAX_REPLAY_TEXT_CHARS);
  if (!text) return null;
  return {
    compressed_text: text,
    original_tokens: Number(response.original_tokens) || 0,
    kept_tokens: Number(response.kept_tokens) || 0,
    tokens_saved: Number(response.tokens_saved) || 0,
    tokens_saved_pct: Number(response.tokens_saved_pct) || 0,
    kv_savings_pct: Number(response.kv_savings_pct) || 0,
    mode: response.mode || null,
    policy_name: response.policy_name || null,
    keep_ratio: response.keep_ratio ?? null,
    coding_agent: response.coding_agent || null,
    source: response.source || null,
    cache_prefix_applied: Boolean(response.cache_prefix_applied),
    ccr: response.ccr || null,
    latency_ms: Number(response.latency_ms) || 0,
  };
}

/**
 * Lookup a prior compress billing row for Idempotency-Key replay.
 * @returns {Promise<object|null>}
 */
async function lookupUsageReplay(uid, requestId) {
  const rid = sanitizeRequestId(requestId);
  if (!uid || !rid || !initFirebaseAdmin()) return null;
  try {
    const snap = await db().collection("billing_usage").doc(`${uid}:${rid}`).get();
    if (snap.exists) return snap.data() || null;
  } catch (err) {
    if (!isFirestoreBackendDown(err)) {
      console.warn("lookupUsageReplay failed:", err?.message || err);
    }
  }
  // Firestore-down fallback: gist-backed idempotency rows.
  try {
    const { loadStore } = require("./store");
    const store = await loadStore();
    const prev = store.billing_usage_fallback?.[`${uid}:${rid}`];
    if (prev) return prev;
  } catch (err) {
    console.warn("lookupUsageReplay fallback failed:", err?.message || err);
  }
  return null;
}

async function applyUsageAndBurn({
  uid,
  tokensIn,
  tokensOut,
  tokensSaved,
  claims = {},
  requestId,
  fingerprint,
  response = null,
}) {
  if (!uid) throw new Error("uid required");
  const rid = sanitizeRequestId(requestId);
  if (!rid) {
    throw billingError("billing_unavailable", "Billing request id required");
  }
  const fp = String(fingerprint || "").trim() || null;
  const replay = sanitizeReplayResponse(response);
  if (!initFirebaseAdmin()) {
    throw billingError("billing_unavailable", "Billing ledger unavailable");
  }

  const ref = db().collection("billing").doc(uid);
  const usageRef = db().collection("billing_usage").doc(`${uid}:${rid}`);
  let result;
  try {
    result = await db().runTransaction(async (tx) => {
      // All reads before writes (Firestore txn rule).
      const usageSnap = await tx.get(usageRef);
      const snap = await tx.get(ref);
      const ledger = normalizeLedger(snap.exists ? snap.data() : null, claims);

      if (usageSnap.exists) {
        const prev = usageSnap.data() || {};
        assertUsageIdempotencyMatch(prev, {
          fingerprint: fp,
          tokensIn,
          tokensOut,
          tokensSaved,
        });
        // Backfill response on legacy rows that billed before replay storage existed.
        if (replay && !prev.response) {
          tx.set(usageRef, { response: replay }, { merge: true });
        }
        return {
          burned_micros: Number(prev.burned_micros || 0),
          ledger,
          already: true,
          request_id: rid,
          fingerprint: prev.fingerprint || fp || null,
          response: prev.response || replay || null,
        };
      }

      const planned = planUsageBurn(ledger, { tokensIn, tokensOut, tokensSaved, claims });
      tx.set(ref, planned.ledger, { merge: true });
      tx.set(
        usageRef,
        {
          uid,
          request_id: rid,
          fingerprint: fp,
          tokens_in: Number(tokensIn) || 0,
          tokens_out: Number(tokensOut) || 0,
          tokens_saved: Number(tokensSaved) || 0,
          burned_micros: planned.burned_micros,
          created_at: new Date().toISOString(),
          ...(replay ? { response: replay } : {}),
        },
        { merge: false }
      );
      return {
        ...planned,
        already: false,
        request_id: rid,
        fingerprint: fp,
        response: replay,
      };
    });
  } catch (err) {
    if (err.paywall || err.code === "free_quota_exhausted" || err.code === "credits_exhausted" || err.code === "idempotency_conflict") {
      throw err;
    }
    // Any Firestore outage (disabled API, timeout, permission) must not 100%-down compress.
    console.warn(
      "billing-ledger: Firestore txn failed — claims/gist billing fallback:",
      err?.code,
      err?.message || err
    );
    try {
      return await applyUsageAndBurnClaimsFallback({
        uid,
        tokensIn,
        tokensOut,
        tokensSaved,
        claims,
        requestId: rid,
        fingerprint: fp,
        response,
      });
    } catch (fallbackErr) {
      if (
        fallbackErr.paywall ||
        fallbackErr.code === "free_quota_exhausted" ||
        fallbackErr.code === "credits_exhausted" ||
        fallbackErr.code === "idempotency_conflict"
      ) {
        throw fallbackErr;
      }
      console.error("billing-ledger claims fallback failed:", fallbackErr?.message || fallbackErr);
      throw billingError("billing_unavailable", "Billing ledger unavailable");
    }
  }

  if (!result.already) {
    await mirrorClaims(uid, result.ledger);
  }
  return result;
}

/**
 * When Cloud Firestore is disabled/unavailable, credit via Auth claims only.
 * Idempotent on sc_credited_sessions / credited_keys. First-pay bonus uses
 * sc_first_pay_bonus_at (weaker than Firestore billing_bonus, but keeps Checkout
 * from silently charging without balance when Firestore is down).
 */
async function creditBalanceClaimsFallback({
  uid,
  creditUsd,
  creditKey,
  claims = {},
  patch = {},
  firstPayBonusUsd = 0,
}) {
  const key = String(creditKey);
  const fresh = await admin().auth().getUser(uid);
  const liveClaims = { ...(fresh.customClaims || {}), ...claims };
  const credited = Array.isArray(liveClaims.sc_credited_sessions)
    ? liveClaims.sc_credited_sessions
    : [];
  const ledger = normalizeLedger(null, liveClaims);
  const keys = Array.isArray(ledger.credited_keys) ? ledger.credited_keys : [];

  if (credited.includes(key) || keys.includes(key)) {
    return {
      applied: true,
      already: true,
      ledger,
      balance: roundUsd(microsToUsd(ledger.credit_balance_micros)),
      credit_usd: 0,
      bonus_usd: 0,
      backend: "claims-fallback",
    };
  }

  const paymentUsd = Number(creditUsd) || 0;
  const wantBonus = Math.max(0, Number(firstPayBonusUsd) || 0);
  const bonusUsd = wantBonus > 0 && !liveClaims.sc_first_pay_bonus_at ? wantBonus : 0;
  const add = usdToMicros(paymentUsd + bonusUsd);
  ledger.credit_balance_micros = Number(ledger.credit_balance_micros || 0) + add;
  if (patch.credit_limit_usd != null) {
    ledger.credit_limit_usd = normalizeCreditLimitUsd(patch.credit_limit_usd);
  }
  if (patch.auto_recharge != null) ledger.auto_recharge = Boolean(patch.auto_recharge);
  if (patch.customer_id) ledger.customer_id = patch.customer_id;
  ledger.credited_keys = [...keys.filter((k) => k !== key).slice(-39), key];
  ledger.updated_at = new Date().toISOString();

  const nextCredited = [...credited.filter((k) => k !== key).slice(-39), key];
  const bonusPatch =
    bonusUsd > 0
      ? {
          sc_first_pay_bonus_at: new Date().toISOString(),
          sc_first_pay_bonus_usd: bonusUsd,
        }
      : {};

  await admin().auth().setCustomUserClaims(uid, {
    ...liveClaims,
    sc_plan: liveClaims.sc_plan || "payg",
    sc_metered: false,
    sc_usage: {
      month: ledger.month,
      requests: ledger.requests,
      tokens_in: ledger.tokens_in,
      tokens_out: ledger.tokens_out,
      tokens_saved: ledger.tokens_saved,
      tokens_reported: ledger.tokens_reported || 0,
    },
    sc_credit_balance_usd: roundUsd(microsToUsd(ledger.credit_balance_micros)),
    sc_credit_limit_usd: ledger.credit_limit_usd,
    sc_auto_recharge: Boolean(ledger.auto_recharge),
    sc_credited_sessions: nextCredited,
    ...(ledger.customer_id ? { sc_customer_id: ledger.customer_id } : {}),
    ...bonusPatch,
  });

  return {
    applied: true,
    already: false,
    ledger,
    balance: roundUsd(microsToUsd(ledger.credit_balance_micros)),
    credit_usd: paymentUsd,
    bonus_usd: bonusUsd,
    backend: "claims-fallback",
  };
}

/**
 * Credit prepaid balance. Idempotent via permanent billing_credits/{creditKey}.
 * Optional first-pay bonus is create-once via billing_bonus/{uid}:first_pay
 * (not Auth claims — avoids concurrent Checkout double-bonus races).
 * Falls back to Auth claims when Cloud Firestore is disabled/unavailable.
 *
 * @param {number} [firstPayBonusUsd=0] candidate bonus; txn grants at most once ever
 */
async function creditBalance({
  uid,
  creditUsd,
  creditKey,
  claims = {},
  patch = {},
  firstPayBonusUsd = 0,
}) {
  if (!uid || !creditKey) return { applied: false, reason: "missing_args" };
  if (!initFirebaseAdmin()) return { applied: false, reason: "firebase_unavailable" };

  const ref = db().collection("billing").doc(uid);
  const creditRef = db().collection("billing_credits").doc(String(creditKey));
  const bonusRef = db().collection("billing_bonus").doc(`${uid}:first_pay`);
  const wantBonus = Math.max(0, Number(firstPayBonusUsd) || 0);

  let result;
  try {
    result = await db().runTransaction(async (tx) => {
      const creditSnap = await tx.get(creditRef);
      const bonusSnap = wantBonus > 0 ? await tx.get(bonusRef) : null;
      const snap = await tx.get(ref);
      const ledger = normalizeLedger(snap.exists ? snap.data() : null, claims);

      if (creditSnap.exists) {
        const prevCredit = creditSnap.data() || {};
        return {
          applied: true,
          already: true,
          ledger,
          balance: roundUsd(microsToUsd(ledger.credit_balance_micros)),
          credit_usd: Number(prevCredit.credit_usd || 0),
          bonus_usd: Number(prevCredit.bonus_usd || 0),
        };
      }

      let bonusUsd = 0;
      if (wantBonus > 0 && bonusSnap && !bonusSnap.exists) {
        bonusUsd = wantBonus;
        tx.set(
          bonusRef,
          {
            uid,
            kind: "first_pay",
            credit_usd: bonusUsd,
            credit_key: String(creditKey),
            created_at: new Date().toISOString(),
          },
          { merge: false }
        );
      }

      const paymentUsd = Number(creditUsd) || 0;
      const totalUsd = paymentUsd + bonusUsd;
      const add = usdToMicros(totalUsd);
      ledger.credit_balance_micros = Number(ledger.credit_balance_micros || 0) + add;
      if (patch.credit_limit_usd != null) {
        ledger.credit_limit_usd = normalizeCreditLimitUsd(patch.credit_limit_usd);
      }
      if (patch.auto_recharge != null) ledger.auto_recharge = Boolean(patch.auto_recharge);
      if (patch.customer_id) ledger.customer_id = patch.customer_id;
      const keys = Array.isArray(ledger.credited_keys) ? ledger.credited_keys : [];
      ledger.credited_keys = [...keys.filter((k) => k !== creditKey).slice(-39), creditKey];
      ledger.updated_at = new Date().toISOString();

      tx.set(
        creditRef,
        {
          uid,
          credit_usd: paymentUsd,
          bonus_usd: bonusUsd,
          created_at: new Date().toISOString(),
        },
        { merge: false }
      );
      tx.set(ref, ledger, { merge: true });
      return {
        applied: true,
        already: false,
        ledger,
        balance: roundUsd(microsToUsd(ledger.credit_balance_micros)),
        credit_usd: paymentUsd,
        bonus_usd: bonusUsd,
      };
    });
  } catch (err) {
    console.warn(
      "billing-ledger: credit txn failed — claims credit fallback:",
      err?.code,
      err?.message || err
    );
    return creditBalanceClaimsFallback({
      uid,
      creditUsd,
      creditKey,
      claims,
      patch,
      firstPayBonusUsd,
    });
  }

  // Patch payg flags only when this credit actually applied (not on replay).
  if (result.applied && !result.already) {
    try {
      const fresh = await admin().auth().getUser(uid);
      const prev = { ...(fresh.customClaims || {}) };
      const bonusPatch =
        result.bonus_usd > 0
          ? {
              sc_first_pay_bonus_at: new Date().toISOString(),
              sc_first_pay_bonus_usd: result.bonus_usd,
            }
          : {};
      await admin().auth().setCustomUserClaims(uid, {
        ...prev,
        sc_plan: prev.sc_plan || "payg",
        sc_metered: false,
        sc_usage: {
          month: result.ledger.month,
          requests: result.ledger.requests,
          tokens_in: result.ledger.tokens_in,
          tokens_out: result.ledger.tokens_out,
          tokens_saved: result.ledger.tokens_saved,
          tokens_reported: result.ledger.tokens_reported,
        },
        sc_credit_balance_usd: roundUsd(microsToUsd(result.ledger.credit_balance_micros)),
        sc_credit_limit_usd: result.ledger.credit_limit_usd,
        sc_auto_recharge: Boolean(result.ledger.auto_recharge),
        ...(result.ledger.customer_id ? { sc_customer_id: result.ledger.customer_id } : {}),
        ...bonusPatch,
      });
    } catch (err) {
      console.warn("credit claim mirror failed:", err.message || err);
      await mirrorClaims(uid, result.ledger);
    }
  } else {
    await mirrorClaims(uid, result.ledger);
  }
  return result;
}

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
  await mirrorClaims(uid, ledger);
  return ledger;
}

module.exports = {
  loadLedger,
  applyUsageAndBurn,
  lookupUsageReplay,
  sanitizeReplayResponse,
  creditBalance,
  acquireRechargeLock,
  markTokensReported,
  mirrorClaims,
  planUsageBurn,
  tokensToMicros,
  usdToMicros,
  microsToUsd,
  monthKey,
  sanitizeRequestId,
  computeCompressFingerprint,
  assertUsageIdempotencyMatch,
  FREE_TOKENS_PER_MONTH,
};
