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
  defaultCatalog,
  normalizeCatalog,
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

  const policy = normalizePolicy(options.policy || { version: 1, compress_default: true });
  const catalog = options.catalog
    ? normalizeCatalog(options.catalog)
    : defaultCatalog();
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

  const providerFn =
    options.provider ||
    createProvider({
      catalog,
      openaiApiKey: options.openaiApiKey,
      anthropicApiKey: options.anthropicApiKey,
      fetchImpl: options.fetchImpl,
      allowStubFallback: options.allowStubFallback !== false,
      requireLive: options.requireLive === true,
    });

  const envFlags = flags();
  const enforceReserve = options.enforceReserve ?? envFlags.reserve;
  const enableLedger = options.enableLedger ?? envFlags.ledger;
  const enableTrace = options.enableTrace ?? envFlags.trace;
  const walletId = options.walletId || "wallet_default";
  const seedBalance = options.seedBalance ?? 100;
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

  money.setBalance(walletId, seedBalance);

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

      const estimated =
        ctx.estimated_max_usd != null ? Number(ctx.estimated_max_usd) : policy.max_usd_per_request || 1;

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
      const rlKey = rateLimitKey(ctx.auth || {});
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
      const idemEarly =
        ctx.normalized?.metadata?.idempotency_key || ctx.idempotency_key || null;
      if (
        enableLedger &&
        idemEarly &&
        typeof ledger.getByIdempotency === "function"
      ) {
        const prev = ledger.getByIdempotency(idemEarly);
        if (prev?.status === "finalized" && prev.meta?.cached_openai && !prev.error_class) {
          ctx.request_id = prev.id;
          ctx.openai = prev.meta.cached_openai;
          ctx.compression = prev.compression || undefined;
          ctx.economics = prev.meta?.economics;
          ctx.model_routed = prev.model_routed;
          ctx.actual_usd = prev.actual_usd;
          ctx.idempotent_replay = true;
          ctx._skip_to_finalize = true;
          return ctx;
        }
      }

      if (!enforceReserve) return ctx;
      try {
        await assertMoneyStoreHealthy(durableStore || money);
      } catch (err) {
        ctx.aborted = true;
        ctx.error = { class: "rejected", message: err.code || "money_store_unavailable" };
        return ctx;
      }
      const amount = Number(ctx.estimated_max_usd) || 0;
      if (!(amount > 0)) return ctx;
      const idem =
        ctx.normalized?.metadata?.idempotency_key ||
        ctx.idempotency_key ||
        `auto_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      try {
        const rsv = await money.reserve(walletId, amount, idem, seedBalance);
        ctx.reservation = rsv;
      } catch (err) {
        ctx.aborted = true;
        ctx.error = {
          class: "rejected",
          message: err.code || err.message || "money_store_unavailable",
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
          idempotency_key: ctx.normalized?.metadata?.idempotency_key || ctx.idempotency_key,
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
      const idem = ctx.normalized?.metadata?.idempotency_key || ctx.idempotency_key;
      const rec = ledger.create({
        org_id: ctx.auth?.org_id,
        key_id: ctx.auth?.key_id,
        agent_id: ctx.auth?.agent_id,
        idempotency_key: idem,
        model_requested: ctx.normalized?.model,
        reservation_id: ctx.reservation?.id,
        reserved_usd: ctx.reservation?.amount_usd,
      });
      ctx.request_id = rec.id;
      // Idempotent replay — LiteLLM caches by key; we replay finalized OpenAI shape.
      if (
        rec.status === "finalized" &&
        rec.meta?.cached_openai &&
        !rec.error_class
      ) {
        ctx.openai = rec.meta.cached_openai;
        ctx.compression = rec.compression || ctx.compression;
        ctx.economics = rec.meta?.economics || ctx.economics;
        ctx.model_routed = rec.model_routed;
        ctx.actual_usd = rec.actual_usd;
        ctx.idempotent_replay = true;
        ctx.aborted = false;
        // Skip remaining stages via short-circuit flag consumed in compress+
        ctx._skip_to_finalize = true;
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
      ctx = (await compressFn(ctx)) || ctx;
      ledgerWrite("transition", ctx.request_id, "compressed", { compression: ctx.compression });
      return ctx;
    },
    async route(ctx) {
      if (ctx.aborted || ctx._skip_to_finalize || ctx.idempotent_replay) return ctx;

      const retained = Number(ctx.compression?.retained_tokens) || 0;
      const original = Number(ctx.compression?.original_tokens) || retained;
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
      });
      ctx.economics = economics;

      if (!enableRouting) {
        ctx.model_routed = ctx.normalized?.model || "stub-model";
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
        if (ctx.reservation?.id) {
          try {
            await money.release(ctx.reservation.id);
          } catch (_) {
            /* ignore */
          }
        }
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
        if (ctx.reservation?.id) {
          try {
            await money.release(ctx.reservation.id);
          } catch (_) {
            /* ignore */
          }
        }
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
          if (ctx.model_routed) healthTracker.recordFailure(ctx.model_routed);
          const retryable = enableRouting && isRetryableProviderError(err);
          if (!retryable || attempt >= maxAttempts - 1) {
            ctx.aborted = true;
            ctx.error = { class: "error", message: err.message, status: err.status };
            if (ctx.reservation?.id) {
              await money.release(ctx.reservation.id);
            }
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
        // First-class streaming: single shared consumer of upstream.
        // HTTP can iterate ctx.stream as chunks arrive; finalize drains if unread.
        let acc = "";
        const gen = (async function* () {
          for await (const piece of upstream) {
            const text = String(piece || "");
            acc += text;
            yield text;
          }
          ctx._stream_drained = true;
          ctx.provider_result.output = { content: acc };
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
        const text =
          typeof ctx.provider_result?.output === "string"
            ? ctx.provider_result.output
            : ctx.provider_result?.output?.content || "";
        if (wantStream) {
          ctx.stream = (async function* () {
            yield text;
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
          ctx.aborted = true;
          ctx.error = { class: "error", message: err.message, status: err.status };
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
        if (ctx.reservation?.id && ctx.reservation.state !== "released") {
          try {
            await money.release(ctx.reservation.id);
          } catch (_) {
            /* ignore */
          }
        }
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
      let actual =
        ctx.actual_usd != null
          ? Number(ctx.actual_usd)
          : null;
      if (actual == null) {
        // Rough cost from catalog rates when usage present; else half of reservation.
        const entry = catalog.get?.(ctx.model_routed);
        if (entry && (usage.input_tokens || usage.output_tokens)) {
          const inCost = ((usage.input_tokens || 0) / 1e6) * (entry.input_usd_per_mtok || 0);
          const outCost = ((usage.output_tokens || 0) / 1e6) * (entry.output_usd_per_mtok || 0);
          actual = Math.round((inCost + outCost) * 1e6) / 1e6;
        } else {
          actual =
            Math.min(
              Number(ctx.reservation?.amount_usd) || 0,
              Number(ctx.estimated_max_usd) || 0
            ) * 0.5 || 0;
        }
      }

      if (ctx.reservation?.id) {
        await money.reconcile(ctx.reservation.id, actual);
      }
      const response = {
        id: `cmpl_${ctx.request_id || "x"}`,
        model: ctx.provider_result?.model || ctx.model_routed,
        output: ctx.provider_result?.output || { content: "" },
        usage: ctx.provider_result?.usage,
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
      ledgerWrite("finalize", ctx.request_id, {
        actual_usd: actual,
        latency_ms: latency,
        model_routed: ctx.model_routed,
        provider: providerName,
        compression: ctx.compression,
        meta: {
          cached_openai: ctx.openai,
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

  async function handleChatCompletions(body, auth = {}) {
    const normalized = fromChatCompletions(body, auth);
    const ctx = await pipeline.run({
      auth,
      normalized,
      user_ask: extractAsk(normalized),
      context: extractContext(normalized),
      idempotency_key: normalized.metadata?.idempotency_key,
      estimated_max_usd: options.estimated_max_usd ?? 1,
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
