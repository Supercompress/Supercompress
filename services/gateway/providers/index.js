"use strict";

const { callStubProvider } = require("./stub");
const { createOpenAIProvider } = require("./openai");
const { createAnthropicProvider } = require("./anthropic");
const registry = require("./registry");

/**
 * Resolve provider name: catalog entry → route decision → "provider/model" prefix → model-id heuristics.
 */
function resolveProviderName(ctx, catalog) {
  const model = ctx.model_routed || ctx.normalized?.model;
  if (catalog && typeof catalog.get === "function") {
    const entry = catalog.get(model);
    if (entry?.provider) return String(entry.provider);
  }
  if (ctx.route_decision?.provider) return String(ctx.route_decision.provider);
  const id = String(model || "");
  if (id === "stub-model" || !id) return "stub";
  return registry.providerFromModelId(id) || "unknown";
}

/**
 * The model id to send upstream: a catalog entry's `upstream_model`, else the id with any
 * "provider/" prefix removed (so "groq/llama-3.3-70b-versatile" calls Groq with "llama-3.3-70b-versatile").
 */
function upstreamModelFor(ctx, catalog) {
  const model = String(ctx.model_routed || ctx.normalized?.model || "");
  const entry = catalog && typeof catalog.get === "function" ? catalog.get(model) : null;
  if (entry?.upstream_model) return String(entry.upstream_model);
  const pre = registry.splitProviderPrefix(model);
  return pre ? pre.model : model;
}

/**
 * Create injectable providerFn for createWiredGateway({ provider }).
 *
 * @param {object} [options]
 * @param {object} [options.catalog] — normalizeCatalog() result with .get
 * @param {Record<string,string>} [options.apiKeys] — per-provider keys, e.g. { groq: "…" } (env otherwise)
 * @param {string} [options.openaiApiKey] — kept for compatibility (same as apiKeys.openai)
 * @param {string} [options.anthropicApiKey] — kept for compatibility (same as apiKeys.anthropic)
 * @param {string} [options.openaiBaseUrl]
 * @param {string} [options.anthropicBaseUrl]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {object} [options.env=process.env]
 * @param {boolean} [options.allowStubFallback=true] — when keys missing, use stub (tests)
 * @param {boolean} [options.requireLive=false] — fail closed if keys missing
 */
function createProvider(options = {}) {
  const env = options.env || process.env;
  const keys = { ...(options.apiKeys || {}) };
  if (options.openaiApiKey) keys.openai = options.openaiApiKey;
  if (options.anthropicApiKey) keys.anthropic = options.anthropicApiKey;
  const catalog = options.catalog;
  const allowStubFallback = options.allowStubFallback !== false;
  const requireLive = options.requireLive === true;
  const adapters = new Map();

  function adapterFor(name) {
    if (adapters.has(name)) return adapters.get(name);
    const spec = registry.PROVIDERS[name];
    if (!spec) return null;
    let fn;
    if (spec.kind === "anthropic") {
      fn = createAnthropicProvider({
        apiKey: keys.anthropic || registry.apiKeyFor("anthropic", env) || undefined,
        baseUrl: options.anthropicBaseUrl,
        fetchImpl: options.fetchImpl,
      });
    } else {
      const explicitBase = name === "openai" ? options.openaiBaseUrl : undefined;
      fn = createOpenAIProvider({
        providerName: name,
        apiKey: keys[name] || registry.apiKeyFor(name, env) || undefined,
        apiKeyEnv: null, // resolved above from the registry (incl. alternate key names)
        baseUrl: explicitBase || (spec.azure ? undefined : registry.chatUrlFor(name, "", env)),
        urlFor: spec.azure ? (model) => registry.chatUrlFor(name, model, env) : undefined,
        auth: spec.auth === "api-key" ? "api-key" : "bearer",
        keyOptional: !spec.keyEnv,
        fetchImpl: options.fetchImpl,
      });
    }
    adapters.set(name, fn);
    return fn;
  }

  async function providerFn(ctx) {
    const name = resolveProviderName(ctx, catalog);
    if (name === "stub") return callStubProvider(ctx);

    const adapter = adapterFor(name);
    if (!adapter) {
      const err = new Error(`provider_unknown:${name}`);
      err.status = 400;
      err.code = "provider_unknown";
      throw err;
    }
    try {
      return await adapter(ctx, { model: upstreamModelFor(ctx, catalog) });
    } catch (err) {
      const missing = `${name}_api_key_missing`;
      if (allowStubFallback && !requireLive && (err.code === missing || err.message === missing)) {
        return callStubProvider(ctx);
      }
      throw err;
    }
  }

  return providerFn;
}

module.exports = {
  createProvider,
  resolveProviderName,
  upstreamModelFor,
  callStubProvider,
  createOpenAIProvider,
  createAnthropicProvider,
  registry,
};
