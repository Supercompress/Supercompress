# Provider adapters (Phase 6)

Replace the stub `defaultProvider` in `wire.js` with real OpenAI + Anthropic clients.
Keys stay **server-side only** (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`). Feature flags remain default OFF.

## Shared contract

Each adapter implements:

```js
/**
 * @param {object} ctx — pipeline context after route
 * @returns {Promise<object>} ctx with provider_result (+ optional stream handle)
 */
async function callProvider(ctx)
```

**Inputs (from ctx):**

| Field | Use |
|-------|-----|
| `ctx.model_routed` | Catalog model id → provider model name |
| `ctx.normalized.messages` | Post-compress messages (ask untouched; bulky context already shrunk) |
| `ctx.normalized.stream` | Prefer SSE / ReadableStream when true |
| `ctx.normalized.tools` / `temperature` / etc. | Pass-through when present |

**Outputs:**

| Field | Shape |
|-------|--------|
| `ctx.provider_result.model` | Echo routed model |
| `ctx.provider_result.output` | `{ content }` (non-stream) or stream handle |
| `ctx.provider_result.usage` | `{ input_tokens, output_tokens }` |
| `ctx.provider_result.raw` | Optional upstream payload (debug only) |
| Errors | Throw with `.status` (429/5xx) so `isRetryableProviderError` + fallbacks work |

**Dispatch:** `createProvider(options)` selects by `catalog.get(model).provider` (`openai` \| `anthropic` \| `stub`). Unknown → fail closed.

Wire via `createWiredGateway({ provider })`; keep stub when keys missing or `SC_CP_GATEWAY` off.

---

## OpenAI adapter — `openai.js`

| Item | Plan |
|------|------|
| API | `POST https://api.openai.com/v1/chat/completions` |
| Auth | `Authorization: Bearer $OPENAI_API_KEY` |
| Models (catalog) | `gpt-4o-mini`, `gpt-4o` |
| Body | Map `NormalizedRequest` → OpenAI chat body; `model` = `ctx.model_routed`; `stream: true` when requested |
| Stream | Native SSE (`data: …` / `[DONE]`); expose async iterator to pipeline `stream` stage; accumulate usage from final chunk when present |
| Non-stream | JSON completion → `output.content` + `usage` |
| Retries | Do **not** retry inside adapter; surface status so gateway fallback walks `fallback_chain` |
| Tests | Contract fixtures (nock/mock fetch): 200 JSON, 200 SSE, 429, 500 |

---

## Anthropic adapter — `anthropic.js`

| Item | Plan |
|------|------|
| API | `POST https://api.anthropic.com/v1/messages` |
| Auth | `x-api-key: $ANTHROPIC_API_KEY` + `anthropic-version` header |
| Models (catalog) | `claude-sonnet-4`, `claude-haiku-3.5` |
| Body map | Split OpenAI-shaped messages: `system` → top-level `system`; user/assistant → `messages`; tools → Anthropic tool schema when present |
| Stream | Anthropic SSE (`message_start` / `content_block_delta` / `message_delta`); normalize to same async-iterator chunks as OpenAI path |
| Non-stream | `content[].text` → `output.content`; map `usage.input_tokens` / `output_tokens` |
| Retries | Same as OpenAI — throw with status; no internal retry loop |
| Tests | Contract fixtures: 200 JSON, 200 SSE, 429, 500 + message-shape round-trip |

---

## File layout (next slices)

```text
services/gateway/providers/
  README.md          ← this plan
  index.js           ← createProvider / resolve by catalog.provider
  openai.js
  anthropic.js
  stub.js            ← current defaultProvider behavior
  *_test.js          ← mock HTTP; no live keys required for CI
```

## Supported providers

`registry.js` lists every upstream the gateway can call. Anthropic uses the native Messages adapter; every other provider speaks OpenAI Chat Completions and shares `openai.js` with its own URL, key and auth header.

| Provider | Key env (base override) | Notes |
|----------|------------------------|-------|
| openai | `OPENAI_API_KEY` (`OPENAI_BASE_URL`) | |
| anthropic | `ANTHROPIC_API_KEY` (`ANTHROPIC_BASE_URL`) | native Messages adapter |
| google | `GEMINI_API_KEY` or `GOOGLE_API_KEY` (`GEMINI_BASE_URL`) | Gemini's OpenAI-compatible endpoint |
| mistral | `MISTRAL_API_KEY` | |
| xai | `XAI_API_KEY` | |
| deepseek | `DEEPSEEK_API_KEY` | |
| groq | `GROQ_API_KEY` | |
| together | `TOGETHER_API_KEY` | |
| fireworks | `FIREWORKS_API_KEY` | |
| perplexity | `PERPLEXITY_API_KEY` | |
| openrouter | `OPENROUTER_API_KEY` | reaches hundreds of models with one key |
| cerebras | `CEREBRAS_API_KEY` | |
| cohere | `COHERE_API_KEY` | Cohere's compatibility endpoint |
| ollama | none; set `OLLAMA_BASE_URL` | local models |
| azure | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` (`AZURE_OPENAI_API_VERSION`) | catalog id = deployment name, `api-key` header |

**Addressing a model.** A catalog entry's `provider` wins. Otherwise a `provider/model` id selects the provider explicitly (`groq/llama-3.3-70b-versatile`, `openrouter/anthropic/claude-sonnet-4`, `ollama/llama3.2`) and the prefix is stripped upstream; bare ids fall back to name heuristics (`gemini*` → google, `grok*` → xai, …). A catalog entry may set `upstream_model` when the routed id and the provider's id differ.

**Catalog.** The gateway routes over `DEFAULT_CATALOG` plus `PROVIDER_CATALOG` entries whose provider is configured, plus operator entries from `SC_CP_CATALOG` (JSON) or `SC_CP_CATALOG_FILE` — see `../catalog-env.js`. A deployment never routes to a provider it has no key for.

## Not yet supported

- AWS Bedrock (SigV4 request signing) — reach Bedrock-hosted models through OpenRouter meanwhile.
- Client-supplied provider keys (keys stay server-side).
- Touching `private/control-plane/evals/**` (Agent B)
