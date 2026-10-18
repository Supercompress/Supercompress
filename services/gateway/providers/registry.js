"use strict";

/**
 * Upstream provider registry for the gateway.
 *
 * Every provider here except Anthropic speaks the OpenAI Chat Completions wire format,
 * so one adapter (openai.js) serves them all with a different base URL, key and auth header.
 * Anthropic keeps its native Messages adapter (anthropic.js).
 *
 * A provider is "configured" when its API key env var is set (or it needs no key, like a
 * local Ollama). The gateway only routes to configured providers' catalog models.
 */

const PROVIDERS = {
  openai: { kind: "openai", url: "https://api.openai.com/v1/chat/completions", keyEnv: "OPENAI_API_KEY", baseEnv: "OPENAI_BASE_URL" },
  anthropic: { kind: "anthropic", keyEnv: "ANTHROPIC_API_KEY", baseEnv: "ANTHROPIC_BASE_URL" },
  google: { kind: "openai", url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", keyEnv: "GEMINI_API_KEY", altKeyEnv: "GOOGLE_API_KEY", baseEnv: "GEMINI_BASE_URL" },
  mistral: { kind: "openai", url: "https://api.mistral.ai/v1/chat/completions", keyEnv: "MISTRAL_API_KEY", baseEnv: "MISTRAL_BASE_URL" },
  xai: { kind: "openai", url: "https://api.x.ai/v1/chat/completions", keyEnv: "XAI_API_KEY", baseEnv: "XAI_BASE_URL" },
  deepseek: { kind: "openai", url: "https://api.deepseek.com/v1/chat/completions", keyEnv: "DEEPSEEK_API_KEY", baseEnv: "DEEPSEEK_BASE_URL" },
  groq: { kind: "openai", url: "https://api.groq.com/openai/v1/chat/completions", keyEnv: "GROQ_API_KEY", baseEnv: "GROQ_BASE_URL" },
  together: { kind: "openai", url: "https://api.together.xyz/v1/chat/completions", keyEnv: "TOGETHER_API_KEY", baseEnv: "TOGETHER_BASE_URL" },
  fireworks: { kind: "openai", url: "https://api.fireworks.ai/inference/v1/chat/completions", keyEnv: "FIREWORKS_API_KEY", baseEnv: "FIREWORKS_BASE_URL" },
  perplexity: { kind: "openai", url: "https://api.perplexity.ai/chat/completions", keyEnv: "PERPLEXITY_API_KEY", baseEnv: "PERPLEXITY_BASE_URL" },
  openrouter: { kind: "openai", url: "https://openrouter.ai/api/v1/chat/completions", keyEnv: "OPENROUTER_API_KEY", baseEnv: "OPENROUTER_BASE_URL" },
  cerebras: { kind: "openai", url: "https://api.cerebras.ai/v1/chat/completions", keyEnv: "CEREBRAS_API_KEY", baseEnv: "CEREBRAS_BASE_URL" },
  cohere: { kind: "openai", url: "https://api.cohere.ai/compatibility/v1/chat/completions", keyEnv: "COHERE_API_KEY", baseEnv: "COHERE_BASE_URL" },
  // Local models: no key. Configured when OLLAMA_BASE_URL is set (e.g. http://localhost:11434/v1).
  ollama: { kind: "openai", url: "http://localhost:11434/v1/chat/completions", keyEnv: null, baseEnv: "OLLAMA_BASE_URL", requiresBase: true },
  // Azure OpenAI: the catalog model id is the deployment name.
  // URL = {AZURE_OPENAI_ENDPOINT}/openai/deployments/{deployment}/chat/completions?api-version=…
  azure: { kind: "openai", keyEnv: "AZURE_OPENAI_API_KEY", baseEnv: "AZURE_OPENAI_ENDPOINT", requiresBase: true, auth: "api-key", azure: true },
};

const AZURE_API_VERSION_DEFAULT = "2024-10-21";

/** Model-id heuristics for ids that carry no provider prefix and are not in the catalog. */
const PREFIX_RULES = [
  [/^claude/i, "anthropic"],
  [/^(gpt-|o[0-9]|chatgpt-)/i, "openai"],
  [/^gemini/i, "google"],
  [/^(mistral|codestral|ministral|magistral|pixtral|devstral)/i, "mistral"],
  [/^grok/i, "xai"],
  [/^deepseek/i, "deepseek"],
  [/^command/i, "cohere"],
  [/^sonar/i, "perplexity"],
];

function envValue(env, name) {
  if (!name) return "";
  const v = env[name];
  return typeof v === "string" ? v.trim() : "";
}

/** The API key for a provider, or "" when none is set. */
function apiKeyFor(name, env = process.env) {
  const p = PROVIDERS[name];
  if (!p) return "";
  return envValue(env, p.keyEnv) || envValue(env, p.altKeyEnv);
}

/** True when the gateway can call this provider with the current environment. */
function isConfigured(name, env = process.env) {
  const p = PROVIDERS[name];
  if (!p) return false;
  if (p.requiresBase && !envValue(env, p.baseEnv)) return false;
  if (!p.keyEnv) return true;
  return Boolean(apiKeyFor(name, env));
}

function configuredProviders(env = process.env) {
  return Object.keys(PROVIDERS).filter((name) => isConfigured(name, env));
}

/**
 * Split an explicit "provider/model" id. Only a known provider name counts as a prefix,
 * so ids that contain slashes for other reasons ("meta-llama/Llama-3.3-70B") pass through.
 * @returns {{ provider: string, model: string } | null}
 */
function splitProviderPrefix(id) {
  const s = String(id || "");
  const i = s.indexOf("/");
  if (i <= 0) return null;
  const provider = s.slice(0, i).toLowerCase();
  if (!PROVIDERS[provider]) return null;
  const model = s.slice(i + 1);
  return model ? { provider, model } : null;
}

function providerFromModelId(id) {
  const pre = splitProviderPrefix(id);
  if (pre) return pre.provider;
  for (const [re, name] of PREFIX_RULES) if (re.test(String(id || ""))) return name;
  return null;
}

/** The chat-completions URL for an OpenAI-compatible provider and upstream model. */
function chatUrlFor(name, upstreamModel, env = process.env) {
  const p = PROVIDERS[name];
  if (!p) return "";
  const base = envValue(env, p.baseEnv);
  if (p.azure) {
    const endpoint = base.replace(/\/+$/, "");
    const version = envValue(env, "AZURE_OPENAI_API_VERSION") || AZURE_API_VERSION_DEFAULT;
    return `${endpoint}/openai/deployments/${encodeURIComponent(upstreamModel)}/chat/completions?api-version=${encodeURIComponent(version)}`;
  }
  if (base) {
    const b = base.replace(/\/+$/, "");
    return /\/chat\/completions$/.test(b) ? b : `${b}/chat/completions`;
  }
  return p.url;
}

module.exports = {
  PROVIDERS,
  AZURE_API_VERSION_DEFAULT,
  apiKeyFor,
  isConfigured,
  configuredProviders,
  splitProviderPrefix,
  providerFromModelId,
  chatUrlFor,
};
