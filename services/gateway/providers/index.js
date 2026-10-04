"use strict";

const { callStubProvider } = require("./stub");
const { createOpenAIProvider } = require("./openai");
const { createAnthropicProvider } = require("./anthropic");

/**
 * Resolve provider name from catalog entry or model id heuristics.
 */
function resolveProviderName(ctx, catalog) {
  const model = ctx.model_routed || ctx.normalized?.model;
  if (catalog && typeof catalog.get === "function") {
    const entry = catalog.get(model);
    if (entry?.provider) return String(entry.provider);
  }
  if (ctx.route_decision?.provider) return String(ctx.route_decision.provider);
  const id = String(model || "");
  if (/^claude/i.test(id)) return "anthropic";
  if (/^gpt-|^o[0-9]/i.test(id)) return "openai";
  if (id === "stub-model" || !id) return "stub";
  return "unknown";
}

/**
 * Create injectable providerFn for createWiredGateway({ provider }).
 *
 * @param {object} [options]
 * @param {object} [options.catalog] — normalizeCatalog() result with .get
 * @param {string} [options.openaiApiKey]
 * @param {string} [options.anthropicApiKey]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {boolean} [options.allowStubFallback=true] — when keys missing, use stub (tests)
 * @param {boolean} [options.requireLive=false] — fail closed if keys missing
 */
function createProvider(options = {}) {
  const openai = createOpenAIProvider({
    apiKey: options.openaiApiKey,
    baseUrl: options.openaiBaseUrl,
    fetchImpl: options.fetchImpl,
  });
  const anthropic = createAnthropicProvider({
    apiKey: options.anthropicApiKey,
    baseUrl: options.anthropicBaseUrl,
    fetchImpl: options.fetchImpl,
  });
  const catalog = options.catalog;
  const allowStubFallback = options.allowStubFallback !== false;
  const requireLive = options.requireLive === true;

  async function providerFn(ctx) {
    const name = resolveProviderName(ctx, catalog);

    if (name === "stub") {
      return callStubProvider(ctx);
    }
    if (name === "openai") {
      try {
        return await openai(ctx);
      } catch (err) {
        if (
          allowStubFallback &&
          !requireLive &&
          (err.code === "openai_api_key_missing" || err.message === "openai_api_key_missing")
        ) {
          return callStubProvider(ctx);
        }
        throw err;
      }
    }
    if (name === "anthropic") {
      try {
        return await anthropic(ctx);
      } catch (err) {
        if (
          allowStubFallback &&
          !requireLive &&
          (err.code === "anthropic_api_key_missing" || err.message === "anthropic_api_key_missing")
        ) {
          return callStubProvider(ctx);
        }
        throw err;
      }
    }

    const err = new Error(`provider_unknown:${name}`);
    err.status = 400;
    err.code = "provider_unknown";
    throw err;
  }

  return providerFn;
}

module.exports = {
  createProvider,
  resolveProviderName,
  callStubProvider,
  createOpenAIProvider,
  createAnthropicProvider,
};
