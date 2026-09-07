# Integration guide

SuperCompress is a **library** — wire it anywhere you build LLM prompts from long context.

## Agent marketplaces (one-command install)

The SuperCompress plugin (MCP tools + skill, with browser account linking) is published for all three major coding agents from this repo:

| Agent | Install |
|-------|---------|
| **Claude Code** | `/plugin marketplace add Supercompress/Supercompress` then `/plugin install supercompress@supercompress` |
| **Codex** | `codex plugin marketplace add Supercompress/Supercompress` then `codex plugin add supercompress@supercompress` |
| **Cursor** | [Cursor Marketplace](https://cursor.com/marketplace) → search "SuperCompress" |

The plugin exposes `compress_context`, `connect_account` (browser sign-in that links your SuperCompress account — free tier 1M tokens/month), and `usage_summary`. Source: [`integrations/plugins/supercompress/`](../integrations/plugins/supercompress/).

## Quick patterns

| Integration | When to use |
|-------------|-------------|
| [Python import](#python) | Any backend, scripts, notebooks |
| [OpenAI-style wrapper](#openai-style-messages) | Chat APIs with `messages[]` |
| [LangChain hook](#langchain) | Chains / agents with message history |
| [Precision Mode](#precision-mode) | Quality-guaranteed compression with verifier |
| [CCR Reversible](#ccr--cache-compress-retrieve) | Zero-loss compression with retrieval |
| [Local HTTP server](#local-http-server) | Dev tools, non-Python clients |
| [Browser demo](#browser) | Judges, docs, no install |

---

## Python

```python
from supercompress import compress_for_turn

compressed, stats = compress_for_turn(
    context_blocks=[system_prompt, tool_output, chat_history],
    user_query=user_message,
    budget_ratio=0.35,
)
# Send `compressed` to your LLM instead of the full merged context
```

Track impact:

```python
from supercompress.benchmarks.metrics import sustainability_from_tokens_saved

saved = stats.original_tokens - stats.kept_tokens
print(sustainability_from_tokens_saved(saved).to_dict())
```

---

## OpenAI-style messages

See `examples/integrations/openai_wrapper.py`:

```python
messages = compress_messages(messages, budget_ratio=0.35)
response = client.chat.completions.create(model="gpt-4o-mini", messages=messages)
```

Only **non-system** context is compressed; the latest user turn stays intact.

---

## LangChain

See `examples/integrations/langchain_hook.py` — compress `HumanMessage` / `AIMessage` history before `invoke()`.

No LangChain dependency in the core package; the example is copy-paste friendly.

---

## Precision Mode

Use the hosted API with `mode="precision"` for answer-quality-first compression:

```python
from supercompress.client import SuperCompress

sc = SuperCompress(api_key="sc_live_YOUR_KEY")
result = sc.compress(
    context,
    query,
    mode="precision"  # confidence-scored compression
)
print(f"Confidence: {result.confidence}")
print(f"Budget selected: {result.budget_ratio}")
print(f"Risk: {result.compression_risk}")
```

Precision mode uses a dual-model architecture (AMCP policy + verifier) that tries progressively aggressive budgets (0.40→0.20) and returns the most compressed output where verifier confidence ≥ 0.85.

See the [full guide](/precision-mode-compression) for details.

---

## CCR — Cache, Compress, Retrieve

Reversible compression: removed blocks become retrieval markers that can be restored on demand.

```python
# Compress with CCR
result = sc.compress(context, query, ccr=True)
# result.compressed_text contains [SC-Retrieve: hash] markers

# Retrieve a removed block (via HTTP)
import requests
response = requests.get(
    f"https://supercompress.dev/api/retrieve?hash={result.ccr['hash']}",
    headers={"X-API-Key": "sc_live_YOUR_KEY"}
)
original = response.json()["original"]
```

CCR caches original content in Firestore (server-side) and an LRU Map (browser-side). Retrieval uses the same API key as compression.

See the [full guide](/reversible-compression-ccr) for details.

---

## Local HTTP server

```bash
pip install -e ".[serve]"   # FastAPI + Uvicorn
python scripts/local_web_server.py
# POST http://127.0.0.1:8790/api/compress
```

Example body:

```json
{
  "context": "long text…",
  "query": "What does fetch return?",
  "budget_ratio": 0.35
}
```

See `examples/integrations/curl_local_server.sh`.

**Production:** hosted API at `https://supercompress.dev/api/v1/compress` (API key required). Browser demo runs in-process via `web/assets/js/compress-engine.js`.

---

## Browser

For static sites and demos:

1. `python scripts/export_model_json.py` → `web/assets/data/model.json`
2. Load `compress-engine.js` and call `SuperCompressEngine.compressContext(...)`

Same eviction logic as Python when the checkpoint JSON is present.

Browser-side CCR:

```javascript
const result = SuperCompressEngine.compressCCR(context, query, model, { enableMarkers: true });
// result.compressed_text has [SC-Retrieve: hash] markers
```

---

## Policy selection

| Call | Policy |
|------|--------|
| `compress_for_turn(...)` / `compress_context(text, q)` | Local query-aware engine (`local-query-aware`) |
| `SuperCompress(...).compress(...)` | Hosted API (`compiler` / `precision`) |

---

## Files

| Path | Purpose |
|------|---------|
| `examples/demo_compare.py` | Local compress demo (shared `CompressResult`) |
| `examples/integrations/openai_wrapper.py` | Message list wrapper |
| `examples/integrations/langchain_hook.py` | History compression hook |
| `examples/integrations/raw_pipeline.py` | Minimal stdin/stdout |
| `docs/API.md` | Full API reference |
| `docs/ENVIRONMENT.md` | CO₂ / kWh methodology |
