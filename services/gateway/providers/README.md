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

## Out of scope here

- Google / Azure / Bedrock adapters
- Client-supplied provider keys
- Public marketing or LiteLLM feature parity
- Touching `private/control-plane/evals/**` (Agent B)
