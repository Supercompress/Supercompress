"use strict";

/**
 * Phase 6 wiring: Auth → Policy → Reserve → Ledger → Compress (NK/local) →
 * Route (retained sizes) → Provider (OpenAI/Anthropic/stub) → Stream → Finalize.
 *
 * Compress/provider/stores are injectable. Flags default OFF — pass explicit
 * enableLedger / enforceReserve / enableTrace / enableRouting in tests.
 */

const crypto = require("crypto");
const { createPipeline, STAGE_ORDER } = require("./pipeline");
const { fromChatCompletions, toChatCompletions } = require("./adapters/chat-completions");
const { createDefaultCompressFn } = require("./compress");
const { createProvider } = require("./providers");
const { catalogFromEnv, policyFromEnv } = require("./catalog-env");
const {
  createLedgerStore,
  createReservationStore,
  createMemoryDurableStore,
  createDurableLedgerStore,
  createDurableReservationStore,
  assertDurableStore,
  evaluateAdmission,
  normalizePolicy,
  traceFromCompressResult,
  flags,
  selectRoute,
  nextFallback,
  isRetryableProviderError,
  normalizeCatalog,
  priceUsd,
} = require("../../packages/control-plane");
const { computeRouteEconomics, attachEconomicsToTrace } = require("../../packages/control-plane/economics");
const { createRateLimitStore, rateLimitKey } = require("../../packages/control-plane/rate-limit");
const { createHealthTracker } = require("../../packages/control-plane/health-tracker");

function loadEnterpriseAdmit() {
  try {
    return require("../../private/control-plane/enterprise/gateway-bridge").admitWithEnterprise;
  } catch {
    return null;
  }
}

/** Rough token count for every message, tool definition and image the request carries. */
function estimateInputTokens(normalized) {
  let chars = 0;
  for (const m of normalized?.messages || []) {
    if (typeof m.content === "string") chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part?.type === "text") chars += String(part.text || "").length;
        else if (part?.type === "image_url") chars += 4 * 1600; // ~1.6K tokens per image
        else chars += JSON.stringify(part || "").length;
      }
    } else if (m.content != null) chars += JSON.stringify(m.content).length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  if (normalized?.tools) chars += JSON.stringify(normalized.tools).length;
  return Math.ceil(chars / 4);
}

/** Output tokens a hold is sized for when the client sets no max_tokens. */
const DEFAULT_OUTPUT_TOKENS = 4096;

/**
 * Idempotency keys are scoped to the tenant and key: two customers who pick the same
 * client key must never see each other's cached completion.
 */
function scopedIdempotencyKey(ctx) {
  const client = ctx.normalized?.metadata?.idempotency_key || ctx.idempotency_key;
  if (!client) return null;
  return `${ctx.auth?.org_id || "-"}:${ctx.auth?.key_id || "-"}:${client}`;
}

function createReplayCache({ max = 1000, ttlMs = 86_400_000 } = {}) {
  const map = new Map();
  return {
    get(key) {
      const row = map.get(key);
      if (!row) return null;
      if (Date.now() > row.expires) {
        map.delete(key);
        return null;
      }
      return row.value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, { value, expires: Date.now() + ttlMs });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get size() {
      return map.size;
    },
  };
}

function ephemeralRequestId() {
  return `req_${crypto.randomBytes(8).toString("hex")}`;
}

/** Fail closed when reservation is required but the money store is unhealthy. */
async function assertMoneyStoreHealthy(money) {
  if (typeof money?.ping !== "function") return;
  const health = await money.ping();
  if (!health?.ok) {
    const err = new Error("money_store_unavailable");
    err.code = "money_store_unavailable";
    throw err;
  }
}

function createWiredGateway(options = {}) {
  let ledger = options.ledger;
  let money = options.money;
  let durableStore = null;
  if (options.store) {
    assertDurableStore(options.store);
    durableStore = options.store;
    ledger = options.store.ledger;
    money = options.store.money;
  } else if (options.durableDir) {
    const path = require("path");
    const dir = String(options.durableDir);
    ledger =
      ledger ||
      createDurableLedgerStore({ path: path.join(dir, "ledger.json") });
    money =
      money ||
      createDurableReservationStore({ path: path.join(dir, "money.json") });
  }
  if (!ledger || !money) {
    const store = createMemoryDurableStore({
      ledger: ledger || createLedgerStore(),
      money: money || createReservationStore(),
      defaultBalance: options.seedBalance,
    });
    ledger = store.ledger;
    money = store.money;
  }

  const policy = normalizePolicy(
    options.policy || policyFromEnv(options.env || process.env) || { version: 1, compress_default: true }
  );
  const catalog = options.catalog
    ? normalizeCatalog(options.catalog)
    : normalizeCatalog(catalogFromEnv(options.env || process.env));
  const staticHealth = options.health || {};
  const rateLimits =
    options.rateLimits ||
    createRateLimitStore({
      windowMs: options.rateLimitWindowMs,
      clock: options.clock,
    });
  const healthTracker =
    options.healthTracker ||
    createHealthTracker({
      failureThreshold: options.healthFailureThreshold,
      successThreshold: options.healthSuccessThreshold,
      cooldownMs: options.healthCooldownMs,
      clock: options.clock,
    });
  const enforceRateLimit = options.enforceRateLimit !== false;

  const compressFn =
    options.compress ||
    createDefaultCompressFn({
      neuralKeep: options.neuralKeep,
      localCompress: options.localCompress,
      preferNeural: options.preferNeural,
    });

  const stubAllowed =
    options.allowStubFallback != null
      ? options.allowStubFallback === true
      : process.env.SC_CP_ALLOW_STUB === "1" && process.env.NODE_ENV !== "production";
  const providerFn =
    options.provider ||
    createProvider({
      catalog,
      openaiApiKey: options.openaiApiKey,
      anthropicApiKey: options.anthropicApiKey,
      fetchImpl: options.fetchImpl,
      // Never answer with the stub in production: a missing provider key is an error.
      allowStubFallback: stubAllowed,
      requireLive: options.requireLive === true || !stubAllowed,
    });

  const envFlags = flags();
  const enforceReserve = options.enforceReserve ?? envFlags.reserve;
  const enableLedger = options.enableLedger ?? envFlags.ledger;
  const enableTrace = options.enableTrace ?? envFlags.trace;
  // One wallet per tenant (org). options.walletId pins a single wallet (tests only).
  const walletFor = (ctx) => options.walletId || `wallet_${ctx.auth?.org_id || "anonymous"}`;
  const seedBalance = options.seedBalance ?? 0;
  // Prepaid-credit bridge (production): holds and charges the customer's SuperCompress credit
  // balance instead of the local money store. See api/_lib/cp-billing.js.
  const billing = options.billing || null;
  const enableRouting = options.enableRouting ?? envFlags.route;
  const enterpriseAdmit = options.enterpriseAdmit || loadEnterpriseAdmit();
  // Optional enterprise admission — only when explicitly enabled (SC_CP_ENTERPRISE or option).
  const enableEnterprise = options.enableEnterprise ?? envFlags.enterprise;
  // HTTP SSE path: defer money/ledger finalize until after the client reads ctx.stream.
  const deferStreamFinalize = options.deferStreamFinalize === true;

  function ledgerWrite(method, ...args) {
    if (!enableLedger) return null;
    return ledger[method](...args);
  }

  // Completed responses for idempotent replay: tenant-scoped keys, 24h TTL, size-capped,
  // kept out of the ledger so the ledger does not grow with every completion body.
  const replayCache = createReplayCache({
    max: Number(process.env.SC_CP_REPLAY_CACHE_MAX) || 1000,
    ttlMs: 24 * 60 * 60 * 1000,
  });

  async function releaseHold(ctx) {
    const r = ctx.reservation;
    if (!r?.id || r.state === "released" || r.state === "settled") return;
    try {
      if (r.billing) await billing.release(r.id);
      else await money.release(r.id);
      r.state = "released";
    } catch (_) {
      /* best effort; a stale hold expires with the process */
    }
  }

  async function settleHold(ctx, actualUsd) {
    const r = ctx.reservation;
    if (!r?.id) return actualUsd;
    if (r.billing) {
      const res = await billing.settle(r.id, actualUsd, { request_id: ctx.request_id });
      r.state = "settled";
      return res?.charged_usd ?? actualUsd;
    }
    // Never charge past the hold: an overrun is absorbed, not pushed into a negative balance.
    const charged = Math.min(Number(actualUsd) || 0, Number(r.amount_usd) || 0);
    await money.reconcile(r.id, charged);
    r.state = "settled";
    return charged;
  }

  const stages = {
    async auth(ctx) {
      if (!ctx.auth?.key_id && !ctx.auth?.org_id) {
        ctx.aborted = true;
        ctx.error = { class: "rejected", message: "auth_required" };
        return ctx;
      }
      ctx.auth_ok = true;
      return ctx;
    },
    async admission(ctx) {
      if (enableEnterprise && typeof enterpriseAdmit === "function") {
        const ent = enterpriseAdmit({
          auth: ctx.auth,
          policy,
          normalized: ctx.normalized,
        });
        ctx.enterprise_admission = ent;
        if (ent && ent.allow === false) {
          ctx.aborted = true;
          ctx.error = {
            class: "rejected",
            message: (ent.reasons || ["enterprise_denied"]).join(","),
          };
          return ctx;
        }
      }

      // Unknown models cannot be priced, so they cannot be billed: reject up front.
      const requestedEntry = catalog.get?.(ctx.normalized?.model);
      if (!requestedEntry && !enableRouting) {
        ctx.aborted = true;
        ctx.error = {
          class: "invalid_request",
          message: `model_not_found: ${String(ctx.normalized?.model || "")}`,
          status: 400,
          code: "model_not_found",
        };
        return ctx;
      }
      ctx.input_tokens_est = estimateInputTokens(ctx.normalized);
      const outTok = Number(ctx.normalized?.max_tokens) > 0 ? Number(ctx.normalized.max_tokens) : DEFAULT_OUTPUT_TOKENS;
      let estimated;
      if (ctx.estimated_max_usd != null) {
        estimated = Number(ctx.estimated_max_usd);
      } else {
        // Hold the worst case before compression: the requested model's price, or the most
        // expensive model routing could pick.
        const pool = requestedEntry ? [requestedEntry] : catalog.models;
        estimated = Math.max(0, ...pool.map((m) => priceUsd(m, ctx.input_tokens_est, outTok)));
        estimated = Math.max(estimated, 0.000001);
      }

      // Day spend from ledger (UTC) — closes the LiteLLM budget gap without Auth claims.
      if (
        ctx.day_spend_usd == null &&
        enableLedger &&
        policy.max_usd_per_day != null &&
        typeof ledger.list === "function"
      ) {
        const { sumDaySpendUsd } = require("../../packages/control-plane/spend");
        ctx.day_spend_usd = sumDaySpendUsd(ledger.list({}), {
          org_id: ctx.auth?.org_id,
          key_id: ctx.auth?.key_id,
        });
      }

      // RPM/TPM sliding window — reject with 429 before other admission reasons.
      // Bucket on org + key only; agent_id is client-chosen and would let a key dodge its limit.
      const rlKey = rateLimitKey({ org_id: ctx.auth?.org_id, key_id: ctx.auth?.key_id });
      const promptTokEst = Math.ceil(String(ctx.context || "").length / 4) || 0;
      if (enforceRateLimit && (policy.rpm != null || policy.tpm != null)) {
        const rlCheck = rateLimits.check(rlKey, policy);
        ctx.rpm_used = rlCheck.rpm_used;
        ctx.tpm_used = rlCheck.tpm_used;
        if (!rlCheck.allow) {
          ctx.aborted = true;
          ctx.error = {
            class: "rejected",
            message: rlCheck.reasons.filter((r) => r !== "ok").join(",") || "rate_limited",
            status: 429,
          };
          return ctx;
        }
      } else {
        const snap = rateLimits.snapshot(rlKey);
        ctx.rpm_used = ctx.rpm_used ?? snap.rpm_used;
        ctx.tpm_used = ctx.tpm_used ?? snap.tpm_used;
      }

      ctx.admission = evaluateAdmission(policy, {
        model: ctx.normalized?.model,
        estimated_usd: estimated,
        rpm_used: ctx.rpm_used,
        tpm_used: ctx.tpm_used,
        day_spend_usd: ctx.day_spend_usd,
      });
      ctx.estimated_max_usd = ctx.admission.estimated_max_usd ?? estimated;
      if (!ctx.admission.allow) {
        ctx.aborted = true;
        const rateHit = ctx.admission.reasons.some(
          (r) => r === "rpm_exceeded" || r === "tpm_exceeded"
        );
        ctx.error = {
          class: "rejected",
          message: ctx.admission.reasons.join(","),
          status: rateHit ? 429 : undefined,
        };
        if (ctx.request_id) {
          ledgerWrite("finalize", ctx.request_id, {
            error_class: "rejected",
            error_message: ctx.error.message,
          });
        }
        return ctx;
      }

      if (enforceRateLimit && (policy.rpm != null || policy.tpm != null)) {
        const rl = rateLimits.consume(rlKey, policy, promptTokEst);
        ctx.rate_limit = rl;
        ctx.rpm_used = rl.rpm_used;
        ctx.tpm_used = rl.tpm_used;
        if (!rl.allow) {
          ctx.aborted = true;
          ctx.error = {
            class: "rejected",
            message: rl.reasons.filter((r) => r !== "ok").join(",") || "rate_limited",
            status: 429,
          };
          return ctx;
        }
      }
      return ctx;
    },
    async reservation(ctx) {
      if (ctx.aborted) return ctx;

      // Idempotent replay before money — avoid re-holding a reconciled reservation.
      const idemEarly = scopedIdempotencyKey(ctx);
      if (
        enableLedger &&
        idemEarly &&
        typeof ledger.getByIdempotency === "function"
      ) {
        const prev = ledger.getByIdempotency(idemEarly);
        const cached = replayCache.get(idemEarly);
        if (prev?.status === "finalized" && cached && !prev.error_class) {
          ctx.request_id = prev.id;
          ctx.openai = cached;
          ctx.compression = prev.compression || undefined;
          ctx.economics = prev.meta?.economics;
          ctx.model_routed = prev.model_routed;
          ctx.actual_usd = prev.actual_usd;
          ctx.idempotent_replay = true;
          ctx._skip_to_finalize = true;
          return ctx;
        }
      }

      if (!enforceReserve && !billing) return ctx;
      const amount = Number(ctx.estimated_max_usd) || 0;
      if (!(amount > 0)) return ctx;
      if (billing) {
        try {
          const hold = await billing.hold(ctx.auth?.org_id, amount, {
            key_id: ctx.auth?.key_id,
            idempotency_key: idemEarly,
          });
          ctx.reservation = { id: hold.id, amount_usd: hold.amount_usd, billing: true, state: "held" };
          // A partial hold (balance below the estimate) caps what routing may spend.
          ctx.estimated_max_usd = hold.amount_usd;
        } catch (err) {
          ctx.aborted = true;
          ctx.error = {
            class: "rejected",
            message: err.code || err.message || "billing_unavailable",
            status: err.status || (err.code === "billing_unavailable" ? 503 : 402),
            code: err.code,
          };
        }
        return ctx;
      }
      try {
        await assertMoneyStoreHealthy(durableStore || money);
      } catch (err) {
        ctx.aborted = true;
        ctx.error = { class: "rejected", message: err.code || "money_store_unavailable" };
        return ctx;
      }
      const idem = idemEarly || `auto_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      try {
        const rsv = await money.reserve(walletFor(ctx), amount, idem, seedBalance);
        ctx.reservation = rsv;
      } catch (err) {
        ctx.aborted = true;
        const code = err.code || err.message || "money_store_unavailable";
        ctx.error = {
          class: "rejected",
          message: code,
          status: /unavailable/.test(code) ? 503 : 402,
        };
      }
      return ctx;
    },
    async ledger(ctx) {
      if (ctx.idempotent_replay) return ctx;
      if (!enableLedger) {
        if (!ctx.request_id) ctx.request_id = ephemeralRequestId();
        return ctx;
      }
      if (ctx.aborted && !ctx.request_id) {
        const rec = ledger.create({
          org_id: ctx.auth?.org_id,
          key_id: ctx.auth?.key_id,
          agent_id: ctx.auth?.agent_id,
          project_id: ctx.normalized?.metadata?.project_id,
          idempotency_key: scopedIdempotencyKey(ctx),
          model_requested: ctx.normalized?.model,
        });
        ctx.request_id = rec.id;
        ledgerWrite("finalize", rec.id, {
          error_class: ctx.error?.class || "rejected",
          error_message: ctx.error?.message,
        });
        return ctx;
      }
      if (ctx.aborted) return ctx;
      const idem = scopedIdempotencyKey(ctx);
      const rec = ledger.create({
        org_id: ctx.auth?.org_id,
        key_id: ctx.auth?.key_id,
        agent_id: ctx.auth?.agent_id,
        project_id: ctx.normalized?.metadata?.project_id,
        idempotency_key: idem,
        model_requested: ctx.normalized?.model,
        reservation_id: ctx.reservation?.id,
        reserved_usd: ctx.reservation?.amount_usd,
      });
      ctx.request_id = rec.id;
      // Idempotent replay — LiteLLM caches by key; we replay finalized OpenAI shape.
      const cachedReplay = idem ? replayCache.get(idem) : null;
      if (rec.status === "finalized" && cachedReplay && !rec.error_class) {
        ctx.openai = cachedReplay;
        ctx.compression = rec.compression || ctx.compression;
        ctx.economics = rec.meta?.economics || ctx.economics;
        ctx.model_routed = rec.model_routed;
        ctx.actual_usd = rec.actual_usd;
        ctx.idempotent_replay = true;
        ctx.aborted = false;
        // Skip remaining stages via short-circuit flag consumed in compress+
        ctx._skip_to_finalize = true;
        await releaseHold(ctx);
        return ctx;
      }
      if (rec.status !== "created" && rec.status !== "finalized") {
        // Same key, still in flight: do not call the provider a second time.
        ctx.aborted = true;
        ctx.error = {
          class: "conflict",
          message: "idempotency_key_in_progress",
          status: 409,
          code: "idempotency_key_in_progress",
        };
        await releaseHold(ctx);
        return ctx;
      }
      if (rec.status === "finalized" && rec.error_class) {
        // Prior failure with same idempotency — surface same rejection
        ctx.aborted = true;
        ctx.error = {
          class: rec.error_class,
          message: rec.error_message || rec.error_class,
        };
        return ctx;
      }
      if (rec.status === "created") {
        ledgerWrite("transition", rec.id, ctx.reservation ? "reserved" : "admitted");
      }
      return ctx;
    },
    async compress(ctx) {
      if (ctx.aborted || ctx._skip_to_finalize || ctx.idempotent_replay) return ctx;
      const scCompress = ctx.normalized?.metadata?.sc_compress;
      const wantCompress = scCompress !== false && policy.compress_default !== false;
      if (!wantCompress) {
        ctx.compression = traceFromCompressResult({
          original_tokens: 0,
          kept_tokens: 0,
          strategy: "skip",
          skip_reason: scCompress === false ? "sc_compress_false" : "compress_default_false",
        });
        ledgerWrite("transition", ctx.request_id, "compressed", { compression: ctx.compression });
        return ctx;
      }
      ctx.compress_opts = {
        include_system: policy.compress_system === true,
        min_chars: policy.compress_min_chars,
        max_blocks: policy.compress_max_blocks,
      };
      ctx = (await compressFn(ctx)) || ctx;
      ledgerWrite("transition", ctx.request_id, "compressed", { compression: ctx.compression });
      return ctx;
    },
    async route(ctx) {
      if (ctx.aborted || ctx._skip_to_finalize || ctx.idempotent_replay) return ctx;

      // Size the request on everything it sends (all messages, tools, images) after
      // compression, not only the compressed blocks.
      const saved = Math.max(
        0,
        (Number(ctx.compression?.original_tokens) || 0) - (Number(ctx.compression?.retained_tokens) || 0)
      );
      const retained = estimateInputTokens(ctx.normalized);
      const original = retained + saved;
      const outTokEst =
        Number(ctx.normalized?.max_tokens) > 0 ? Number(ctx.normalized.max_tokens) : undefined;
      const liveHealth = { ...staticHealth, ...healthTracker.healthMap() };

      // Always compute compress→route economics (moat proof), even if routing is passthrough.
      const economics = computeRouteEconomics({
        original_tokens: original,
        retained_tokens: retained,
        requested_model: ctx.normalized?.model,
        policy,
        catalog: catalog.models,
        health: liveHealth,
        require_capabilities: ctx.require_capabilities || policy.routing?.require_capabilities,
        max_usd_per_request: ctx.estimated_max_usd ?? policy.max_usd_per_request,
        output_tokens_est: outTokEst,
      });
      ctx.economics = economics;

      if (!enableRouting) {
        ctx.model_routed = ctx.normalized?.model;
        ctx.route_decision = {
          model: ctx.model_routed,
          provider: catalog.get?.(ctx.model_routed)?.provider || null,
          strategy: "passthrough",
          reason: "route_flag_off",
          allow: true,
          retained_tokens: retained,
          fallback_chain: [ctx.model_routed],
          fallback_index: 0,
          max_retries: 0,
          eligibility: [],
        };
        if (ctx.compression) {
          ctx.compression = attachEconomicsToTrace(
            {
              ...ctx.compression,
              meta: {
                ...(ctx.compression.meta || {}),
                route_reason: "route_flag_off",
                route_strategy: "passthrough",
              },
            },
            economics
          );
        }
        ledgerWrite("transition", ctx.request_id, "routed", { model_routed: ctx.model_routed });
        return ctx;
      }

      // Post-compress retained size — never pre-compress estimate.
      const decision = selectRoute({
        requested_model: ctx.normalized?.model,
        retained_tokens: retained,
        policy,
        catalog: catalog.models,
        health: liveHealth,
        require_capabilities: ctx.require_capabilities || policy.routing?.require_capabilities,
        max_usd_per_request: ctx.estimated_max_usd ?? policy.max_usd_per_request,
        output_tokens_est: outTokEst,
      });
      ctx.route_decision = decision;

      if (ctx.compression) {
        ctx.compression = attachEconomicsToTrace(
          {
            ...ctx.compression,
            model_eligibility: decision.eligibility.filter((e) => e.fit).map((e) => e.model),
            meta: {
              ...(ctx.compression.meta || {}),
              route_reason: decision.reason,
              route_strategy: decision.strategy,
            },
          },
          economics
        );
      }

      if (!decision.allow || !decision.model) {
        ctx.aborted = true;
        ctx.error = decision.error || { class: "rejected", message: "no_viable_model" };
        await releaseHold(ctx);
        ledgerWrite("finalize", ctx.request_id, {
          error_class: "rejected",
          error_message: ctx.error.message,
          compression: ctx.compression,
        });
        return ctx;
      }

      // Post-compress spend gate — abort before provider if routed est exceeds reservation/cap.
      const postUsd = Number(decision.estimated_usd);
      const cap =
        ctx.reservation?.amount_usd != null
          ? Number(ctx.reservation.amount_usd)
          : ctx.estimated_max_usd != null
            ? Number(ctx.estimated_max_usd)
            : policy.max_usd_per_request;
      if (
        Number.isFinite(postUsd) &&
        cap != null &&
        Number.isFinite(Number(cap)) &&
        postUsd > Number(cap) + 1e-9
      ) {
        ctx.aborted = true;
        ctx.error = {
          class: "rejected",
          message: `post_compress_usd:${postUsd}>${cap}`,
        };
        await releaseHold(ctx);
        ledgerWrite("finalize", ctx.request_id, {
          error_class: "rejected",
          error_message: ctx.error.message,
          compression: ctx.compression,
          model_routed: decision.model,
        });
        return ctx;
      }

      ctx.model_routed = decision.model;
      ledgerWrite("transition", ctx.request_id, "routed", {
        model_routed: ctx.model_routed,
        compression: ctx.compression,
      });
      return ctx;
    },
    async provider(ctx) {
      if (ctx.aborted || ctx.idempotent_replay || ctx._skip_to_finalize) return ctx;
      const decision = ctx.route_decision;
      const maxAttempts =
        enableRouting && decision?.fallback_chain?.length
          ? Math.min(decision.fallback_chain.length, (decision.max_retries ?? 0) + 1)
          : 1;

      let lastErr = null;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const step =
          enableRouting && decision ? nextFallback(decision, attempt) : null;
        if (enableRouting && decision && !step) break;
        if (step) {
          ctx.model_routed = step.model;
          ctx.route_decision = step;
        }

        const providerName =
          step?.provider ||
          catalog.get?.(ctx.model_routed)?.provider ||
          "unknown";

        ledgerWrite("transition", ctx.request_id, "attempted", {
          provider: providerName,
          model_routed: ctx.model_routed,
          attempt,
        });

        try {
          ctx = (await providerFn(ctx)) || ctx;
          ctx.provider_name = ctx.provider_result?.provider || providerName;
          if (ctx.model_routed) healthTracker.recordSuccess(ctx.model_routed);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          // Only provider-side failures (429/5xx/timeouts) count against a model's health;
          // one tenant's bad requests must not take a model down for everyone.
          if (ctx.model_routed && isRetryableProviderError(err)) {
            healthTracker.recordFailure(ctx.model_routed);
          }
          const retryable = enableRouting && isRetryableProviderError(err);
          if (!retryable || attempt >= maxAttempts - 1) {
            ctx.aborted = true;
            ctx.error = { class: "error", message: err.message, status: err.status, code: err.code };
            await releaseHold(ctx);
            ledgerWrite("finalize", ctx.request_id, {
              error_class: "error",
              error_message: err.message,
              compression: ctx.compression,
              model_routed: ctx.model_routed,
              provider: providerName,
            });
            return ctx;
          }
        }
      }
      if (lastErr && !ctx.aborted) {
        ctx.aborted = true;
        ctx.error = { class: "error", message: lastErr.message };
      }
      return ctx;
    },
    async stream(ctx) {
      if (ctx.aborted || ctx.idempotent_replay || ctx._skip_to_finalize) return ctx;
      const wantStream = ctx.normalized?.stream === true;
      const upstream = ctx.provider_result?.stream;
      if (
        wantStream &&
        upstream &&
        typeof upstream[Symbol.asyncIterator] === "function"
      ) {
        // First-class streaming: single shared consumer of upstream. Pieces are
        // { content?, tool_calls? } deltas (strings from older providers are wrapped).
        // HTTP iterates ctx.stream as chunks arrive; finalize drains if unread.
        let acc = "";
        const gen = (async function* () {
          try {
            for await (const raw of upstream) {
              const piece = typeof raw === "string" ? { content: raw } : raw || {};
              if (piece.content) acc += piece.content;
              yield piece;
            }
          } catch (err) {
            // A stream that dies mid-way is a failed request, not a success.
            ctx.stream_error = err;
            throw err;
          } finally {
            ctx._stream_drained = true;
          }
          const out = ctx.provider_result.output;
          if (!out || typeof out !== "object" || !out.content) {
            ctx.provider_result.output = { ...(out && typeof out === "object" ? out : {}), content: acc };
          }
        })();
        ctx.stream = gen;
        ctx.drainStream = async () => {
          if (ctx._stream_drained) {
            return ctx.provider_result?.output?.content || acc;
          }
          for await (const _piece of gen) {
            /* accumulate inside generator */
          }
          return ctx.provider_result?.output?.content || acc;
        };
      } else {
        const out = ctx.provider_result?.output;
        const text = typeof out === "string" ? out : out?.content || "";
        if (wantStream) {
          const toolCalls = out && typeof out === "object" ? out.tool_calls : null;
          ctx.stream = (async function* () {
            const piece = {};
            if (text) piece.content = text;
            if (toolCalls?.length) {
              piece.tool_calls = toolCalls.map((tc, index) => ({ index, ...tc }));
            }
            if (piece.content || piece.tool_calls) yield piece;
          })();
          ctx._stream_drained = true;
        } else {
          ctx.stream = null;
          ctx._stream_drained = true;
        }
      }
      ledgerWrite("transition", ctx.request_id, "streamed");
      return ctx;
    },
    async finalize(ctx) {
      if (ctx.idempotent_replay && ctx.openai) {
        return ctx;
      }
      if (
        deferStreamFinalize &&
        ctx.normalized?.stream &&
        !ctx.force_finalize &&
        !ctx.aborted
      ) {
        ctx._deferred_finalize = true;
        return ctx;
      }
      // Non-HTTP callers may never read ctx.stream — drain so output/usage finalize.
      if (ctx.drainStream && !ctx._stream_drained) {
        try {
          await ctx.drainStream();
        } catch (err) {
          ctx.stream_error = ctx.stream_error || err;
        }
      }
      if (ctx.stream_error && !ctx.aborted) {
        ctx.aborted = true;
        ctx.error = {
          class: "error",
          message: ctx.stream_error.message || "upstream_stream_error",
          status: ctx.stream_error.status || 502,
          code: ctx.stream_error.code,
        };
        if (ctx.model_routed && isRetryableProviderError(ctx.stream_error)) {
          healthTracker.recordFailure(ctx.model_routed);
        }
      }
      if (enableLedger && ctx.request_id && ledger.get(ctx.request_id)?.status === "finalized") {
        return ctx;
      }
      const started = ctx.started_at_ms || Date.now();
      const latency = Date.now() - started;
      const providerName =
        ctx.provider_name ||
        ctx.provider_result?.provider ||
        catalog.get?.(ctx.model_routed)?.provider ||
        "unknown";

      if (ctx.aborted) {
        await releaseHold(ctx);
        if (ctx.request_id) {
          ledgerWrite("finalize", ctx.request_id, {
            error_class: ctx.error?.class || "error",
            error_message: ctx.error?.message,
            latency_ms: latency,
            compression: enableTrace ? ctx.compression : undefined,
            provider: providerName,
          });
        }
        return ctx;
      }

      const usage = ctx.provider_result?.usage || {};
      let actual = ctx.actual_usd != null ? Number(ctx.actual_usd) : null;
      if (actual == null) {
        const entry = catalog.get?.(ctx.model_routed);
        if (entry && (usage.input_tokens || usage.output_tokens)) {
          actual = priceUsd(entry, usage.input_tokens || 0, usage.output_tokens || 0);
        } else {
          // No usage reported: charge the routed estimate rather than guessing low.
          actual = Number(ctx.route_decision?.estimated_usd) || Number(ctx.reservation?.amount_usd) || 0;
        }
      }

      try {
        actual = await settleHold(ctx, actual);
      } catch (err) {
        // The provider already answered; record the miss for reconciliation, still respond.
        console.error("[cp] settle failed", ctx.request_id, err?.code || err?.message);
        ctx.billing_error = err?.code || err?.message || "settle_failed";
      }
      const response = {
        id: `chatcmpl-${ctx.request_id || "x"}`,
        model: ctx.provider_result?.model || ctx.model_routed,
        output: ctx.provider_result?.output || { content: "" },
        usage: ctx.provider_result?.usage,
        finish_reason: ctx.provider_result?.finish_reason || undefined,
        created: Math.floor((ctx.started_at_ms || Date.now()) / 1000),
        compression: enableTrace ? ctx.compression : undefined,
        economics: enableTrace ? ctx.economics : undefined,
        request_id: enableLedger ? ctx.request_id : undefined,
      };
      ctx.response = response;
      ctx.openai = toChatCompletions(response);
      if (enableTrace && ctx.economics) {
        ctx.openai.sc_economics = ctx.economics;
      }
      if (enableTrace && ctx.compression) {
        ctx.openai.sc_compression_trace = ctx.compression;
      }
      ctx.actual_usd = actual;
      const idem = scopedIdempotencyKey(ctx);
      if (idem) replayCache.set(idem, ctx.openai);
      ledgerWrite("finalize", ctx.request_id, {
        actual_usd: actual,
        latency_ms: latency,
        model_routed: ctx.model_routed,
        provider: providerName,
        compression: ctx.compression,
        meta: {
          economics: ctx.economics,
        },
      });
      if (typeof ledger.flush === "function") {
        try {
          await ledger.flush();
        } catch (_) {
          /* best-effort durable ledger flush */
        }
      }
      return ctx;
    },
  };

  const pipeline = createPipeline(stages);

  async function handleChatCompletions(body, auth = {}, extra = {}) {
    const normalized = fromChatCompletions(body, auth);
    const ctx = await pipeline.run({
      auth,
      normalized,
      user_ask: extractAsk(normalized),
      context: extractContext(normalized),
      idempotency_key: normalized.metadata?.idempotency_key,
      // Tests may pin the hold; otherwise admission prices it from the catalog.
      estimated_max_usd: options.estimated_max_usd,
      abort_signal: extra.abort_signal,
      started_at_ms: Date.now(),
      flags: flags(),
    });
    return ctx;
  }

  async function finalizeDeferred(ctx) {
    if (!ctx) return ctx;
    ctx.force_finalize = true;
    ctx._deferred_finalize = false;
    return stages.finalize(ctx);
  }

  return {
    handleChatCompletions,
    finalizeDeferred,
    pipeline,
    ledger,
    money,
    catalog,
    rateLimits,
    healthTracker,
    replayCache,
    STAGE_ORDER,
  };
}

function extractAsk(normalized) {
  const msgs = normalized?.messages || [];
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  const c = lastUser?.content;
  return typeof c === "string" ? c : "";
}

function extractContext(normalized) {
  const msgs = normalized?.messages || [];
  const systems = msgs.filter((m) => m.role === "system").map((m) => m.content).filter((c) => typeof c === "string");
  return systems.join("\n");
}

module.exports = {
  createWiredGateway,
  STAGE_ORDER,
  fromChatCompletions,
  toChatCompletions,
};
