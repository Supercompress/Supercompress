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
  const ledger = await loadLedger(owner.uid, claims);
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

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method !== "POST" && req.method !== "GET") return json(res, 405, { detail: "Method not allowed" });

  try {
    // Support API key from: X-API-Key header, Authorization Bearer, or ?api_key query param
    const raw = req.headers["x-api-key"]
      || bearerToken(req.headers.authorization)
      || (req.query && req.query.api_key);
    if (!raw || !raw.startsWith(KEY_PREFIX)) {
      // Scanners often GET /api/v1/compress. Soft 200 keeps Observability error rate
      // from spiking; real clients use POST + key and still get hard 401.
      if (req.method === "GET") {
        return json(res, 200, {
          ok: false,
          auth: "required",
          service: "supercompress",
          detail: "Pass X-API-Key (sc_live_…) to compress. Prefer POST /api/v1/compress.",
        });
      }
      return json(res, 401, { detail: "Missing or invalid API key" });
    }

    // ── Rate limit: fast per-key + durable per-IP hourly ceiling ──
    const keyPrefix = raw.slice(0, 24);
    const ip = clientIp(req);
    const rlMem = checkRateLimit(`v1:${keyPrefix}`, V1_RPM);
    if (!rlMem.allowed) {
      return jsonWithRateLimit(res, 429, {
        detail: `Rate limit exceeded (${V1_RPM} requests/minute per key). Reduce request frequency or contact support.`,
        retry_after_seconds: Math.max(1, Math.ceil((rlMem.resetMs - Date.now()) / 1000)),
      }, rlMem);
    }
    const rl = await enforceRateLimits([
      { key: `v1ip:h:${ip}`, max: V1_IP_HOURLY, windowMs: 60 * 60_000 },
    ]);
    if (!rl.allowed) {
      return jsonWithRateLimit(res, 429, {
        detail: `IP rate limit exceeded (${V1_IP_HOURLY}/hour). Spread traffic or contact support.`,
        retry_after_seconds: Math.max(1, Math.ceil((rl.resetMs - Date.now()) / 1000)),
      }, rl);
    }
    // Prefer showing the tighter remaining of the two windows
    rl.remaining = Math.min(rl.remaining, rlMem.remaining);
    rl.limit = V1_RPM;

    // Read input outside mutateStore to avoid await inside sync callback
    let context, query, mode, budgetRatio, ccr, cache_prefix, coding_agent, skipLog, source, session_id;
    if (req.method === "GET") {
      context = (req.query && req.query.context) || "";
      query = (req.query && req.query.query) || "Summarize this context.";
      mode = (req.query && req.query.mode) || "compiler";
      budgetRatio = mode === "fixed" ? parseFloat(req.query.budget_ratio || "0.35") : 0.35;
      ccr = (req.query && req.query.ccr === "true");
      cache_prefix = (req.query && req.query.cache_prefix === "true");
      coding_agent = (req.query && req.query.coding_agent) || null;
      skipLog = req.query && (req.query.log === "0" || req.query.log === "false");
      source = (req.query && req.query.source) || null;
      session_id = (req.query && req.query.session_id) || null;
    } else {
      const body = readBody(req);
      context = body.context || "";
      query = body.query || "Summarize this context.";
      mode = body.mode || "compiler";
      budgetRatio = mode === "fixed" ? (body.budget_ratio ?? 0.35) : 0.35;
      ccr = body.ccr === true || body.ccr === "true";
      cache_prefix = body.cache_prefix === true || body.cache_prefix === "true";
      coding_agent = body.coding_agent || null;
      skipLog = body.log === false || body.log === "false";
      source = body.source || null;
      session_id = body.session_id || null;
    }

    if (!context.trim()) {
      return json(res, 422, { detail: "context required" });
    }
    if (context.length > 120_000) {
      return json(res, 422, { detail: "context too long (120k max)" });
    }

    const authenticated = await authenticateKey(raw);
    await enforceUsageLimit(authenticated.owner);

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
    await recordUsage(authenticated.user, authenticated.owner, result);

    // Infer source when client omitted it (agent key name / coding_agent).
    const inferredSource =
      source ||
      (coding_agent ? "agent" : null) ||
      (authenticated.user?.name && /coding agent|cli|mcp|plugin/i.test(authenticated.user.name)
        ? "agent"
        : "api");

    // Activity log: capped previews only (never full dumps).
    if (!skipLog) {
      try {
        const { appendCompressLog } = require("../_lib/compress-log");
        const tokensSaved = Math.max(
          0,
          result.tokens_saved ?? Math.max(0, (result.original_tokens || 0) - (result.kept_tokens || 0))
        );
        await appendCompressLog(authenticated.ownerUid, {
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
        });
      } catch (err) {
        console.warn("compress log skipped:", err.message);
      }
    }

    // Track coding agent usage in a dedicated Firestore collection (more reliable
    // than mutating the monolithic config/store document).
    if (coding_agent) {
      try {
        const { trackCodingAgentUsage } = require("../_lib/store");
        const tokensSaved = Math.max(0, (result.original_tokens || 0) - (result.kept_tokens || 0));
        await trackCodingAgentUsage(authenticated.ownerUid, coding_agent, {
          original_tokens: result.original_tokens,
          kept_tokens: result.kept_tokens,
          tokens_saved: tokensSaved,
          latency_ms: latencyMs,
          query,
          source: inferredSource,
        });
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
    if (ccr && result.ccr) {
      // Compiler mode + CCR: compressCCR produced interspersed markers
      const { stored, stored_hashes, full_stored } = await storeCcrBlocks(result.ccr, context, {
        ownerUid: authenticated.ownerUid,
        keyId: authenticated.keyId || authenticated.user?.id,
      });
      if (stored) {
        ccrInfo = {
          hash: result.ccr.hash,
          marker_hashes: result.ccr.marker_hashes || [],
          markers_count: result.ccr.markers_count || 0,
          stored_hashes,
          full_stored,
          retrieve_url: `/retrieve?hash=${result.ccr.hash}`,
        };
      }
    } else if (ccr) {
      // Fixed mode + CCR (or any mode where compressCCR wasn't used):
      // Fall back to simple full-context storage with end-of-text marker
      const { simpleHash, ccrStoreFirestore } = require("../_lib/engine");
      const ccrHash = simpleHash(context);
      const stored = await ccrStoreFirestore(ccrHash, context, {
        ownerUid: authenticated.ownerUid,
        keyId: authenticated.keyId || authenticated.user?.id,
      });
      if (stored) {
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

    // CacheAligner: optionally wrap compressed text for provider prompt/prefix
    // caching. SuperCompress does not operate inside model KV cache.
    const rawText = ccrInfo && ccrInfo.markers_count === 0
      ? result.compressed_text + `\n[SC-Retrieve: ${ccrInfo.hash}]\n`
      : result.compressed_text;
    const finalText = cache_prefix
      ? wrapCompressedForCache(rawText, query).wrapped
      : rawText;

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
    }, rl);
  } catch (err) {
    const status = err.status || 500;
    // Expected auth/validation failures are not production incidents — avoid
    // inflating Vercel Observability error rate via console.error.
    if (status >= 500) console.error("compress error", err);
    else console.warn("compress client error", status, err.message || err);
    if (err.paywall && err.payload) {
      return json(res, status, {
        ...err.payload,
        detail: err.payload.detail || err.message || String(err),
      });
    }
    return json(res, status, {
      detail: err.message || String(err),
      ...(err.code ? { code: err.code } : {}),
      ...(err.paywall ? { paywall: true } : {}),
    });
  }
};
