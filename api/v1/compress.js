/**
 * POST /api/v1/compress
 * Authenticated compression endpoint.
 * Rate-limited: 120 req/min per API key + monthly plan token limit.
 */
const { json, jsonWithRateLimit, checkRateLimit, clientIp, readBody } = require("../_lib/http");
const { enforceRateLimits } = require("../_lib/rate-limit-durable");
const { bearerToken } = require("../_lib/auth");
const { KEY_PREFIX } = require("../_lib/keys");
const { authenticateKey, recordUsage } = require("../_lib/firebase-key-store");
const { compress, compressAdaptive, compressCCR, storeCcrBlocks, wrapCompressedForCache } = require("../_lib/engine");
const {
  FREE_TOKENS_PER_MONTH,
  isPaygEnabled,
  isComped,
  isLegacyMetered,
  isCreditWallet,
  attemptAutoRecharge,
  roundUsd,
} = require("../_lib/stripe");
const crypto = require("crypto");
const { sanitizeRequestId } = require("../_lib/billing-ledger");

const V1_RPM = 90; // per API key (in-memory fast path)
const V1_IP_HOURLY = 600; // durable per-IP ceiling (stops stolen-key / fan-out abuse)

/**
 * Free accounts hard-stop at the monthly free allowance (1M).
 * Legacy metered / comped PAYG may exceed freely.
 * Credit-wallet PAYG may exceed free only while prepaid balance > 0 (or auto-recharge succeeds).
 */
async function enforceUsageLimit(owner) {
  const claims = owner.customClaims || {};
  const planId = claims.sc_plan || "free";

  if (isComped(claims) || isLegacyMetered(claims)) return;
  if (isPaygEnabled(planId) && !isCreditWallet(claims) && claims.sc_credit_balance_usd == null) {
    // Transition: treat as credit wallet with 0 balance until top-up
  }

  const { loadLedger, microsToUsd } = require("../_lib/billing-ledger");
  let ledger;
  try {
    ledger = await loadLedger(owner.uid, claims);
  } catch (err) {
    const e = new Error("Billing unavailable — try again shortly.");
    e.status = 503;
    e.code = "billing_unavailable";
    throw e;
  }
  const tokensUsedThisPeriod = Number(ledger.tokens_in || 0);

  if (tokensUsedThisPeriod < FREE_TOKENS_PER_MONTH) return;

  const upgradeUrl = "https://www.supercompress.dev/dashboard#billing";
  const usedM = (tokensUsedThisPeriod / 1_000_000).toFixed(2);
  const freeM = (FREE_TOKENS_PER_MONTH / 1_000_000).toFixed(0);

  // Past free allowance
  if (!isPaygEnabled(planId) && !isCreditWallet(claims)) {
    const err = new Error(
      `PAYWALL: Free ${freeM}M tokens used (${usedM}M this month). Compression is paused. Add credits to unlock — $0.30 per 1M tokens after free (min $10 load). ${upgradeUrl}`
    );
    err.status = 402;
    err.code = "free_quota_exhausted";
    err.paywall = true;
    err.payload = {
      ok: false,
      paywall: true,
      code: "free_quota_exhausted",
      title: "Free allowance used — unlock to keep compressing",
      detail: `You've used your free ${freeM}M tokens this month (${usedM}M so far). Compression is paused until you add credits.`,
      tokens_used: tokensUsedThisPeriod,
      free_tokens: FREE_TOKENS_PER_MONTH,
      price: "$0.30 / 1M tokens after free",
      cta: "Add payment method",
      upgrade_url: upgradeUrl,
      action: "open_billing",
    };
    throw err;
  }

  let balance = roundUsd(
    microsToUsd(ledger.credit_balance_micros) || claims.sc_credit_balance_usd || 0
  );
  if (balance > 0) return;

  if (claims.sc_auto_recharge || ledger.auto_recharge) {
    const recharge = await attemptAutoRecharge(owner);
    if (recharge.ok) {
      const freshLedger = await loadLedger(owner.uid, owner.customClaims || claims);
      owner.customClaims = {
        ...(owner.customClaims || claims),
        sc_credit_balance_usd: roundUsd(microsToUsd(freshLedger.credit_balance_micros)),
      };
      if (roundUsd(owner.customClaims.sc_credit_balance_usd || 0) > 0) return;
    }
  }

  const err = new Error(
    `PAYWALL: Prepaid balance is $0. Top up credits to resume compression. ${upgradeUrl}`
  );
  err.status = 402;
  err.code = "credits_exhausted";
  err.paywall = true;
  err.payload = {
    ok: false,
    paywall: true,
    code: "credits_exhausted",
    title: "Credits empty — top up to resume",
    detail: "Your prepaid SuperCompress balance is $0. Add credits or turn on auto-recharge to keep compressing.",
    credit_balance_usd: 0,
    price: "$0.30 / 1M tokens",
    cta: "Top up credits",
    upgrade_url: upgradeUrl,
    action: "open_billing",
  };
  throw err;
}

/** Soft deadline so Firestore/Stripe side-effects don't push past Vercel maxDuration. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label || "operation"} timed out after ${ms}ms`);
      err.code = "timeout";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function stripRetrieveMarkers(text) {
  return String(text || "")
    .replace(/\[SC-Retrieve:\s*[^\]]+\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function resolveRequestId(req, body) {
  const header =
    req.headers["idempotency-key"] ||
    req.headers["x-idempotency-key"] ||
    req.headers["x-request-id"];
  return (
    sanitizeRequestId(header) ||
    sanitizeRequestId(body?.idempotency_key) ||
    sanitizeRequestId(body?.request_id) ||
    crypto.randomUUID()
  );
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  // Compression is POST-only — never accept API keys or context in query strings.
  if (req.method === "GET") {
    return json(res, 405, {
      ok: false,
      detail: "Use POST /api/v1/compress with X-API-Key (or Authorization: Bearer). Query-string keys/context are not supported.",
      allow: "POST",
    });
  }
  if (req.method !== "POST") return json(res, 405, { detail: "Method not allowed" });

  const requestStarted = Date.now();
  // Leave headroom under function maxDuration (60s for this route) for response flush.
  const HARD_BUDGET_MS = 55_000;
  let requestId = null;

  try {
    const raw = req.headers["x-api-key"] || bearerToken(req.headers.authorization);
    if (!raw || !raw.startsWith(KEY_PREFIX)) {
      return json(res, 401, { detail: "Missing or invalid API key" });
    }

    // Parse body early so Idempotency-Key can come from JSON when header omitted.
    const body = readBody(req);
    requestId = resolveRequestId(req, body);

    // ── Rate limit: fast per-key + durable per-IP hourly ceiling ──
    const keyPrefix = raw.slice(0, 24);
    const ip = clientIp(req);
    const rlMem = checkRateLimit(`v1:${keyPrefix}`, V1_RPM);
    if (!rlMem.allowed) {
      return jsonWithRateLimit(res, 429, {
        detail: `Rate limit exceeded (${V1_RPM} requests/minute per key). Reduce request frequency or contact support.`,
        retry_after_seconds: Math.max(1, Math.ceil((rlMem.resetMs - Date.now()) / 1000)),
        request_id: requestId,
      }, rlMem);
    }
    let rl;
    try {
      rl = await withTimeout(
        enforceRateLimits(
          [{ key: `v1ip:h:${ip}`, max: V1_IP_HOURLY, windowMs: 60 * 60_000 }],
          { requestId }
        ),
        2000,
        "rate_limit"
      );
    } catch (err) {
      return json(res, 503, {
        detail: "Rate limit service unavailable. Retry shortly.",
        code: "rate_limit_unavailable",
        request_id: requestId,
      }, { "Idempotency-Key": requestId });
    }
    if (rl.backend && rl.backend !== "firestore") {
      return json(res, 503, {
        detail: "Rate limit service unavailable. Retry shortly.",
        code: "rate_limit_unavailable",
        request_id: requestId,
      }, { "Idempotency-Key": requestId });
    }
    if (!rl.allowed) {
      return jsonWithRateLimit(res, 429, {
        detail: `IP rate limit exceeded (${V1_IP_HOURLY}/hour). Spread traffic or contact support.`,
        retry_after_seconds: Math.max(1, Math.ceil((rl.resetMs - Date.now()) / 1000)),
        request_id: requestId,
      }, rl);
    }
    // Prefer showing the tighter remaining of the two windows
    rl.remaining = Math.min(rl.remaining, rlMem.remaining);
    rl.limit = V1_RPM;

    const context = body.context || "";
    const query = body.query || "Summarize this context.";
    const mode = body.mode || "compiler";
    const budgetRatio = mode === "fixed" ? (body.budget_ratio ?? 0.35) : 0.35;
    const ccr = body.ccr === true || body.ccr === "true";
    const cache_prefix = body.cache_prefix === true || body.cache_prefix === "true";
    const coding_agent = body.coding_agent || null;
    const skipLog = body.log === false || body.log === "false";
    const source = body.source || null;
    const session_id = body.session_id || null;

    if (!context.trim()) {
      return json(res, 422, { detail: "context required", request_id: requestId }, {
        "Idempotency-Key": requestId,
      });
    }
    if (context.length > 120_000) {
      return json(res, 422, { detail: "context too long (120k max)", request_id: requestId }, {
        "Idempotency-Key": requestId,
      });
    }

    const authenticated = await withTimeout(authenticateKey(raw), 8000, "authenticate");
    await withTimeout(enforceUsageLimit(authenticated.owner), 10000, "usage_limit");

    if (mode === "fixed" && (budgetRatio < 0.05 || budgetRatio > 1)) {
      const err = new Error("invalid budget_ratio");
      err.status = 422;
      throw err;
    }

    const compressStarted = Date.now();
    const result = mode === "fixed"
      ? compress(context, query, budgetRatio)
      : await (ccr ? compressCCR(context, query) : compressAdaptive(context, query));
    const latencyMs = Math.max(0, Date.now() - compressStarted);

    const remainingMs = () => HARD_BUDGET_MS - (Date.now() - requestStarted);
    // Billing is fail-closed: never return compressed text without a durable charge/quota write.
    try {
      await withTimeout(
        recordUsage(authenticated.user, authenticated.owner, result, { requestId }),
        Math.max(1500, Math.min(12000, remainingMs() - 2000)),
        "record_usage"
      );
    } catch (err) {
      if (err.paywall || err.status === 402) throw err;
      const e = new Error(
        err.code === "timeout"
          ? "Billing timed out — compression not delivered. Retry with the same Idempotency-Key."
          : "Billing unavailable — compression not delivered. Retry with the same Idempotency-Key."
      );
      e.status = err.status || 503;
      e.code = err.code || "billing_unavailable";
      e.requestId = requestId;
      throw e;
    }

    // Infer source when client omitted it (agent key name / coding_agent).
    const inferredSource =
      source ||
      (coding_agent ? "agent" : null) ||
      (authenticated.user?.name && /coding agent|cli|mcp|plugin/i.test(authenticated.user.name)
        ? "agent"
        : "api");

    // Activity log: capped previews only (never full dumps). Skip when budget is tight.
    if (!skipLog && remainingMs() > 4000) {
      try {
        const { appendCompressLog } = require("../_lib/compress-log");
        const tokensSaved = Math.max(
          0,
          result.tokens_saved ?? Math.max(0, (result.original_tokens || 0) - (result.kept_tokens || 0))
        );
        await withTimeout(appendCompressLog(authenticated.ownerUid, {
          query,
          original_preview: context,
          compressed_preview: result.compressed_text,
          tokens_in: result.original_tokens,
          tokens_out: result.kept_tokens,
          tokens_saved: tokensSaved,
          tokens_saved_pct: result.tokens_saved_pct ?? result.kv_savings_pct,
          coding_agent: coding_agent || null,
          key_prefix: authenticated.user?.prefix || raw.slice(0, 16),
          mode,
          source: inferredSource,
          session_id: session_id || null,
          latency_ms: latencyMs,
        }), Math.min(4000, remainingMs() - 1500), "compress_log");
      } catch (err) {
        console.warn("compress log skipped:", err.message);
      }
    }

    // Track coding agent usage in a dedicated Firestore collection (more reliable
    // than mutating the monolithic config/store document).
    if (coding_agent && remainingMs() > 3000) {
      try {
        const { trackCodingAgentUsage } = require("../_lib/store");
        const tokensSaved = Math.max(0, (result.original_tokens || 0) - (result.kept_tokens || 0));
        await withTimeout(trackCodingAgentUsage(authenticated.ownerUid, coding_agent, {
          original_tokens: result.original_tokens,
          kept_tokens: result.kept_tokens,
          tokens_saved: tokensSaved,
          latency_ms: latencyMs,
          query,
          source: inferredSource,
        }), Math.min(3000, remainingMs() - 1000), "coding_agent_usage");
      } catch (err) {
        console.warn("Failed to track coding agent usage:", err.message);
      }
    }

    // CacheAligner: persist block-level hashes to Blob (async, after mutateStore completes)
    // The compressCCR result (compiler+CCR mode) already has [SC-Retrieve: hash] markers
    // interspersed at the exact positions where blocks were dropped. We just need to
    // persist each block's text to Blob so retrieval works across cold starts.
    // For fixed+CCR, fall back to basic full-context storage (no block markers).
    let ccrInfo = null;
    let compressedText = result.compressed_text;
    if (ccr) {
      let storedOk = false;
      if (remainingMs() > 2500) {
        try {
          if (result.ccr) {
            const { stored, stored_hashes, full_stored } = await withTimeout(
              storeCcrBlocks(result.ccr, context, {
                ownerUid: authenticated.ownerUid,
                keyId: authenticated.keyId || authenticated.user?.id,
              }),
              Math.min(8000, remainingMs() - 1000),
              "ccr_store"
            );
            if (stored) {
              storedOk = true;
              ccrInfo = {
                hash: result.ccr.hash,
                marker_hashes: result.ccr.marker_hashes || [],
                markers_count: result.ccr.markers_count || 0,
                stored_hashes,
                full_stored,
                retrieve_url: `/retrieve?hash=${result.ccr.hash}`,
              };
            }
          } else {
            const { simpleHash, ccrStoreFirestore } = require("../_lib/engine");
            const ccrHash = simpleHash(context);
            const stored = await withTimeout(
              ccrStoreFirestore(ccrHash, context, {
                ownerUid: authenticated.ownerUid,
                keyId: authenticated.keyId || authenticated.user?.id,
              }),
              Math.min(5000, remainingMs() - 1000),
              "ccr_store_full"
            );
            if (stored) {
              storedOk = true;
              ccrInfo = {
                hash: ccrHash,
                marker_hashes: [],
                markers_count: 0,
                stored_hashes: [],
                full_stored: true,
                retrieve_url: `/retrieve?hash=${ccrHash}`,
              };
            }
          }
        } catch (err) {
          console.warn("CCR store failed:", err.message);
        }
      }
      // Persistence is part of a valid CCR result — never return dangling retrieve markers.
      if (!storedOk) {
        compressedText = stripRetrieveMarkers(compressedText);
        ccrInfo = null;
      }
    }

    // CacheAligner: optionally wrap compressed text for provider prompt/prefix
    // caching. SuperCompress does not operate inside model KV cache.
    const rawText = ccrInfo && ccrInfo.markers_count === 0
      ? compressedText + `\n[SC-Retrieve: ${ccrInfo.hash}]\n`
      : compressedText;
    const finalText = cache_prefix
      ? wrapCompressedForCache(rawText, query).wrapped
      : rawText;

    res.setHeader("Idempotency-Key", requestId);
    return jsonWithRateLimit(res, 200, {
      compressed_text: finalText,
      original_tokens: result.original_tokens,
      kept_tokens: result.kept_tokens,
      tokens_saved: result.tokens_saved ?? Math.max(0, result.original_tokens - result.kept_tokens),
      tokens_saved_pct: Math.round((result.tokens_saved_pct ?? result.kv_savings_pct ?? 0) * 100) / 100,
      // deprecated alias — same value as tokens_saved_pct
      kv_savings_pct: Math.round((result.tokens_saved_pct ?? result.kv_savings_pct ?? 0) * 100) / 100,
      kept_line_ratio: result.kept_line_ratio,
      policy_name: result.policy_name,
      mode: result.mode || "compiler",
      keep_ratio: result.keep_ratio ?? result.budget_ratio,
      answer_quality: result.answer_quality,
      important_kept_pct: result.important_kept_pct,
      critical_lines_total: result.critical_lines_total,
      critical_lines_kept: result.critical_lines_kept,
      critical_lines_dropped: result.critical_lines_dropped,
      compression_risk: result.compression_risk,
      verifier: result.verifier,
      kept_blocks: result.kept_blocks,
      dropped_blocks: result.dropped_blocks,
      cache_prefix_applied: cache_prefix || false,
      ccr: ccrInfo,
      latency_ms: latencyMs,
      coding_agent: coding_agent || null,
      source: inferredSource,
      request_id: requestId,
    }, rl);
  } catch (err) {
    let status = err.status || 500;
    if (err.code === "timeout" && !err.status) status = 504;
    // Expected auth/validation failures are not production incidents — avoid
    // inflating Vercel Observability error rate via console.error.
    if (status >= 500) console.error("compress error", err);
    else console.warn("compress client error", status, err.message || err);
    const idHeaders = requestId ? { "Idempotency-Key": requestId } : undefined;
    if (err.paywall && err.payload) {
      return json(res, status, {
        ...err.payload,
        detail: err.payload.detail || err.message || String(err),
        ...(requestId ? { request_id: requestId } : {}),
      }, idHeaders);
    }
    return json(res, status, {
      detail: err.message || String(err),
      ...(err.code ? { code: err.code } : {}),
      ...(err.paywall ? { paywall: true } : {}),
      ...(requestId ? { request_id: requestId } : {}),
    }, idHeaders);
  }
};
