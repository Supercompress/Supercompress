"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const registry = require("./registry");
const { createProvider, resolveProviderName, upstreamModelFor } = require("./index");
const { catalogFromEnv, policyFromEnv } = require("../catalog-env");
const { normalizeCatalog, selectRoute } = require("../../../packages/control-plane");

function okFetch(calls, model = "m") {
  return async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ model, choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
const ctxFor = (model) => ({ model_routed: model, normalized: { model, messages: [{ role: "user", content: "hello" }] } });

describe("provider registry", () => {
  it("resolves providers from model ids", () => {
    const cases = { "gpt-4o-mini": "openai", "o3-mini": "openai", "claude-sonnet-4": "anthropic", "gemini-2.5-pro": "google", "mistral-large-latest": "mistral",
      "codestral-latest": "mistral", "grok-4": "xai", "deepseek-chat": "deepseek", "command-a-03-2025": "cohere", "sonar-pro": "perplexity",
      "groq/llama-3.3-70b-versatile": "groq", "openrouter/meta-llama/llama-3.3-70b-instruct": "openrouter", "ollama/llama3.2": "ollama" };
    for (const [id, want] of Object.entries(cases)) assert.equal(registry.providerFromModelId(id), want, id);
    assert.equal(registry.providerFromModelId("meta-llama/Llama-3.3-70B-Instruct"), null);
  });

  it("splits only known provider prefixes", () => {
    assert.deepEqual(registry.splitProviderPrefix("together/meta-llama/Llama-3.3-70B-Instruct-Turbo"), { provider: "together", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" });
    assert.equal(registry.splitProviderPrefix("meta-llama/Llama-3.3-70B"), null);
  });

  it("knows which providers are configured", () => {
    const env = { GROQ_API_KEY: "g", GOOGLE_API_KEY: "x", OLLAMA_BASE_URL: "http://localhost:11434/v1" };
    assert.equal(registry.isConfigured("groq", env), true);
    assert.equal(registry.isConfigured("google", env), true); // alternate key name
    assert.equal(registry.isConfigured("ollama", env), true);
    assert.equal(registry.isConfigured("mistral", env), false);
    assert.equal(registry.isConfigured("azure", { AZURE_OPENAI_API_KEY: "k" }), false); // needs an endpoint too
  });

  it("builds chat URLs, honouring base overrides and Azure deployments", () => {
    assert.equal(registry.chatUrlFor("groq", "x", {}), "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(registry.chatUrlFor("openrouter", "x", { OPENROUTER_BASE_URL: "https://proxy.example/v1/" }), "https://proxy.example/v1/chat/completions");
    assert.equal(registry.chatUrlFor("azure", "my-gpt4o", { AZURE_OPENAI_ENDPOINT: "https://acme.openai.azure.com/" }),
      `https://acme.openai.azure.com/openai/deployments/my-gpt4o/chat/completions?api-version=${registry.AZURE_API_VERSION_DEFAULT}`);
  });
});

describe("createProvider across providers", () => {
  it("calls Groq with its URL, key and the prefix-stripped model", async () => {
    const calls = [];
    const fn = createProvider({ env: { GROQ_API_KEY: "gk" }, fetchImpl: okFetch(calls), allowStubFallback: false });
    const ctx = await fn(ctxFor("groq/llama-3.3-70b-versatile"));
    assert.equal(calls[0].url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(calls[0].init.headers.Authorization, "Bearer gk");
    assert.equal(calls[0].body.model, "llama-3.3-70b-versatile");
    assert.equal(ctx.provider_result.provider, "groq");
    assert.equal(ctx.provider_result.output.content, "hi");
  });

  it("calls Gemini through Google's OpenAI-compatible endpoint", async () => {
    const calls = [];
    const fn = createProvider({ env: { GEMINI_API_KEY: "gem" }, fetchImpl: okFetch(calls), allowStubFallback: false });
    await fn(ctxFor("gemini-2.5-flash"));
    assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    assert.equal(calls[0].body.model, "gemini-2.5-flash");
  });

  it("uses Azure deployment URLs and the api-key header", async () => {
    const calls = [];
    const fn = createProvider({ env: { AZURE_OPENAI_API_KEY: "az", AZURE_OPENAI_ENDPOINT: "https://acme.openai.azure.com" }, fetchImpl: okFetch(calls), allowStubFallback: false });
    await fn(ctxFor("azure/prod-gpt-4o"));
    assert.match(calls[0].url, /^https:\/\/acme\.openai\.azure\.com\/openai\/deployments\/prod-gpt-4o\/chat\/completions\?api-version=/);
    assert.equal(calls[0].init.headers["api-key"], "az");
    assert.equal(calls[0].init.headers.Authorization, undefined);
  });

  it("calls a local Ollama with no key", async () => {
    const calls = [];
    const fn = createProvider({ env: { OLLAMA_BASE_URL: "http://localhost:11434/v1" }, fetchImpl: okFetch(calls), allowStubFallback: false });
    await fn(ctxFor("ollama/llama3.2"));
    assert.equal(calls[0].url, "http://localhost:11434/v1/chat/completions");
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.equal(calls[0].body.model, "llama3.2");
  });

  it("falls back to the stub without a key, and fails closed when live is required", async () => {
    const stubbed = await createProvider({ env: {} })(ctxFor("mistral-small-latest"));
    assert.ok(stubbed.provider_result, "stub fallback produced a result");
    await assert.rejects(() => createProvider({ env: {}, requireLive: true })(ctxFor("mistral-small-latest")), (e) => e.code === "mistral_api_key_missing");
  });

  it("rejects unknown providers", async () => {
    await assert.rejects(() => createProvider({ env: {} })(ctxFor("totally-unknown-model")), (e) => e.code === "provider_unknown");
  });

  it("sends a catalog entry's upstream_model", async () => {
    const calls = [];
    const catalog = normalizeCatalog([{ id: "cheap-llama", provider: "openrouter", upstream_model: "meta-llama/llama-3.3-70b-instruct", max_context_tokens: 128000 }]);
    assert.equal(resolveProviderName(ctxFor("cheap-llama"), catalog), "openrouter");
    assert.equal(upstreamModelFor(ctxFor("cheap-llama"), catalog), "meta-llama/llama-3.3-70b-instruct");
    await createProvider({ env: { OPENROUTER_API_KEY: "or" }, catalog, fetchImpl: okFetch(calls), allowStubFallback: false })(ctxFor("cheap-llama"));
    assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(calls[0].body.model, "meta-llama/llama-3.3-70b-instruct");
  });
});

describe("catalog from env", () => {
  it("keeps the default catalog when no extra provider is configured", () => {
    const ids = catalogFromEnv({}).map((m) => m.id);
    assert.deepEqual(ids.sort(), ["claude-haiku-3.5", "claude-sonnet-4", "gpt-4o", "gpt-4o-mini", "stub-model"]);
  });

  it("adds a provider's models only when its key is set", () => {
    const ids = catalogFromEnv({ GEMINI_API_KEY: "g" }).map((m) => m.id);
    assert.ok(ids.includes("gemini-2.5-flash") && ids.includes("gemini-2.5-pro"));
    assert.ok(!ids.includes("grok-4"));
  });

  it("merges operator entries from SC_CP_CATALOG, replacing by id", () => {
    const env = { SC_CP_CATALOG: JSON.stringify([{ id: "gpt-4o-mini", provider: "openai", max_context_tokens: 128000, input_usd_per_mtok: 0.1 }, { id: "my-model", provider: "together", max_context_tokens: 32000 }]) };
    const list = catalogFromEnv(env);
    assert.equal(list.find((m) => m.id === "gpt-4o-mini").input_usd_per_mtok, 0.1);
    assert.ok(list.find((m) => m.id === "my-model"));
    assert.throws(() => catalogFromEnv({ SC_CP_CATALOG: "{not json" }), (e) => e.code === "catalog_invalid_json");
  });

  it("routes a context too big for every default model to a long-context provider once configured", () => {
    const retained = 400_000;
    const without = selectRoute({ requested_model: "gpt-4o-mini", retained_tokens: retained, catalog: catalogFromEnv({}), policy: { version: 1, routing: { strategy: "cheapest_fit" } } });
    assert.equal(without.allow, false);
    const withGemini = selectRoute({ requested_model: "gpt-4o-mini", retained_tokens: retained, catalog: catalogFromEnv({ GEMINI_API_KEY: "g" }), policy: { version: 1, routing: { strategy: "cheapest_fit" } } });
    assert.equal(withGemini.allow, true);
    assert.equal(withGemini.model, "gemini-2.5-flash");
  });
});

describe("policy from env", () => {
  it("is null when unset, parses SC_CP_POLICY, and rejects bad JSON", () => {
    assert.equal(policyFromEnv({}), null);
    const p = policyFromEnv({ SC_CP_POLICY: JSON.stringify({ allow_models: ["gpt-4o-mini"], rpm: 30, routing: { strategy: "latency_prefer" } }) });
    assert.deepEqual(p.allow_models, ["gpt-4o-mini"]);
    assert.equal(p.routing.strategy, "latency_prefer");
    assert.throws(() => policyFromEnv({ SC_CP_POLICY: "[1,2]" }), (e) => e.code === "policy_invalid_json");
    assert.throws(() => policyFromEnv({ SC_CP_POLICY: "{oops" }), (e) => e.code === "policy_invalid_json");
  });
});
