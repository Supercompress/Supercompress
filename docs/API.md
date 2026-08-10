# SuperCompress API

Python library and hosted API — compile long context down to the smallest useful prompt for a query.

**Dashboard:** [API_DASHBOARD.md](API_DASHBOARD.md) · **Integrations:** [INTEGRATIONS.md](INTEGRATIONS.md)

## Install

```bash
pip install git+https://github.com/Supercompress/Supercompress.git
# dev + tests
pip install -e ".[dev,serve]"
```

## Quick start

```python
from supercompress import compress_context

result = compress_context(
    text=open("context.txt").read(),
    query="What does fetch return when the row is missing?",
)

print(result.compressed_text)       # send to your LLM
print(result.tokens_saved_pct)      # tokens removed before your LLM call
print(result.original_tokens, result.kept_tokens)
```

The hosted API does not require a budget. It uses compiler mode by default: maximize tokens removed while keeping important query evidence.

```bash
export SUPERCOMPRESS_API_KEY=sc_live_YOUR_KEY

curl -X POST https://supercompress.dev/api/v1/compress \
  -H "X-API-Key: $SUPERCOMPRESS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"context":"long text…","query":"What matters?"}'
```

Compiler response fields:

| Field | Description |
|-------|-------------|
| `tokens_saved` | Tokens removed from this API call |
| `tokens_saved_pct` | Percent of input tokens removed |
| `important_kept_pct` | Estimated share of important context preserved |
| `compression_risk` | `low`, `medium`, or `high` verifier risk |
| `preprocessor` | Content type detected: `json`, `code`, `log`, or `none` |
| `kept_blocks` | Evidence blocks kept, with reasons |
| `dropped_blocks` | Largest removed blocks |

## Modes

SuperCompress supports three compression modes:

### Compiler mode (default)

Query-aware context compiler. Removes the most tokens it can while preserving answer-critical evidence. No budget needed.

```python
result = compress_context(text, query)  # local compiler fallback
```

### Precision mode

Dual-model architecture: AMCP policy + verifier confidence classifier. Tries progressively aggressive budgets (0.40→0.20) and uses the most aggressive ratio where verifier confidence ≥ 0.85.

```python
from supercompress.client import SuperCompress
sc = SuperCompress(api_key="sc_live_...")
result = sc.compress(
    context="long context…",
    query="What matters?",
    mode="precision"
)
```

Additional response fields:

| Field | Description |
|-------|-------------|
| `confidence` | Verifier confidence score (0–1) |
| `confidence_ok` | Whether confidence ≥ 0.85 threshold |
| `budget_ratio` | Budget ratio selected by precision search |

### Fixed-ratio mode (legacy)

Explicit token budget — kept for research baselines.

```python
result = compress_context(text, query, budget_ratio=0.35)
```

## Domain Preprocessors

Content-aware preprocessing runs automatically in compiler and precision modes. The content router detects the text type and applies specialized transformations.

### Content type detection

The router samples the first 50 lines and classifies them:

| Route | Detected By | Preprocessor |
|-------|------------|-------------|
| `json` | JSON brackets (`{`, `[`) present, config/table patterns | JSON SmartCrusher |
| `code` | Imports, definitions, fences, comments dominate | Code AST compressor |
| `log` | Log level tags, stack trace patterns, timestamps | Log/Trace compressor |
| `text` | None of the above (default pass-through) | — |

### Preprocessor details

**JSON SmartCrusher**
- Drops `null` fields and empty arrays
- Samples homogeneous arrays: keeps 3 + count for arrays > 12 items
- Truncates long strings (> 200 chars)
- Drops timestamps from well-known keys
- Only replaces if crushed text is ≥ 15% smaller

**Code AST compressor**
- Strips docstrings (`"""`, `'''`), block comments (`/* */`), line comments (`//`, `#`, `;`), JSDoc annotations
- Collapses multi-line data literals into single lines
- Preserves: defs, classes, interfaces, decorators, return/yield/throw, imports
- Collapses runs of 3+ blank lines into at most 1

**Log/Trace compressor**
- Collapses long stack traces to first + last frame
- Deduplicates repeated messages (fingerprinted by normalizing timestamps/numbers)
- Filters DEBUG/TRACE lines unless the question asks about them
- Concentrates ERROR/WARN lines when the question mentions errors

### Accessing preprocessor info

```python
result = compress_context(text, query)
print(result.compressed_text)
print(result.policy_name, result.mode, result.tokens_saved_pct)
```

Hosted responses may also include engine-specific fields such as `kept_blocks` / `dropped_blocks` on the raw JSON; the shared `CompressResult` exposes the common metrics above.

## CCR — Cache, Compress, Retrieve

Reversible compression: removed blocks are replaced with retrieval markers. The original content can be restored on demand.

```bash
# Request compression with CCR
curl -X POST https://supercompress.dev/api/v1/compress \
  -H "X-API-Key: sc_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"context": "long text…", "query": "What matters?", "ccr": true}'

# Response includes ccr field:
# {
#   "compressed_text": "... [SC-Retrieve: a1b2c3d4] ...",
#   "ccr": {
#     "hash": "a1b2c3d4e5f6_1a2b",
#     "stored": true,
#     "retrieve_url": "/api/retrieve?hash=a1b2c3d4e5f6_1a2b"
#   }
# }

# Retrieve original
curl https://supercompress.dev/api/retrieve?hash=a1b2c3d4e5f6_1a2b
```

### Browser-side CCR

```javascript
const result = SuperCompressEngine.compressCCR(context, query, model, { enableMarkers: true });
// result.compressed_text contains [SC-Retrieve: hash] markers
// Use SuperCompressEngine.ccrRetrieve(hash) to get original
```

## Functions

### `compress_for_turn(context, user_query, context_blocks=None, budget_ratio=0.35, mode="compiler")`

Query-aware local compression. Returns a shared `CompressResult` (same type as the hosted client).

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `context` | str | required | Full context to trim (ignored when `context_blocks` is set) |
| `user_query` | str | required | Current user query — drives retention (not appended to output) |
| `context_blocks` | list[str] \| None | `None` | Optional list of blocks joined before compression |
| `budget_ratio` | float | `0.35` | Fraction of lines to keep; must be in `(0, 1]` |
| `mode` | str | `"compiler"` | Local `"compiler"`, or `"precision"` (hosted; requires `SUPERCOMPRESS_API_KEY`) |

**Raises:** `ValueError` if `budget_ratio` ∉ `(0, 1]`. `RuntimeError` if `mode="precision"` without an API key.

```python
from supercompress import compress_for_turn

result = compress_for_turn(
    context="",
    user_query="Summarize the API",
    context_blocks=["## Notes\n…", "## Code\n…"],
    budget_ratio=0.35,
)
print(result.compressed_text, result.tokens_saved_pct)
```

### `compress_context(text, query, budget_ratio=0.35)`

Alias for `compress_for_turn` with a single context string. Returns `CompressResult`.

```python
from supercompress import compress_context

result = compress_context(ctx, "What does fetch return?")
```

### Hosted client — `SuperCompress.compress(...)`

```python
from supercompress.client import SuperCompress

sc = SuperCompress(api_key="sc_live_…")
result = sc.compress(context, query, mode="precision")
# same CompressResult type as local compress_for_turn
```

## `CompressResult`

Shared by local engine and hosted API (`supercompress.result.CompressResult`).

| Field | Type | Description |
|-------|------|-------------|
| `compressed_text` | str | Trimmed context for your LLM |
| `original_tokens` | int | Tokens before compression |
| `kept_tokens` | int | Tokens retained |
| `tokens_saved_pct` | float | `(1 - kept/original) × 100` |
| `tokens_saved` | int \| None | `original - kept` (filled in `__post_init__`) |
| `policy_name` | str | e.g. `local-query-aware`, `SuperCompress-compiler` |
| `mode` | str | `compiler` or `precision` |
| `keep_ratio` | float | Retention budget used |
| `kept_line_ratio` | float | Share of lines kept (API; local may be `0`) |
| `cache_prefix_applied` | bool | Hosted cache-aligner flag |
| `compression_risk` | float \| None | Verifier risk (when available) |
| `confidence` | float \| None | Confidence score (when available) |
| `ccr` | dict \| None | CCR retrieve payload (when enabled) |

## Environmental impact

```python
from supercompress.benchmarks.metrics import sustainability_from_tokens_saved

saved = result.original_tokens - result.kept_tokens
impact = sustainability_from_tokens_saved(saved)
print(impact.to_dict())
```

See [ENVIRONMENT.md](./ENVIRONMENT.md) for assumptions.

## Hosted API (production)

Use `POST /api/v1/compress` with `context` and `query`. Do not pass a budget unless you intentionally want the legacy fixed-ratio mode.

Optional parameters:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `mode` | str | `"compiler"` | `"compiler"`, `"precision"`, or `"fixed"` |
| `ccr` | bool | `false` | Enable reversible compression (markers + storage) |
| `cache_prefix` | bool | `false` | Wrap compressed output in a deterministic XML preamble/postamble so providers can reuse **prompt/prefix cache**. SuperCompress does not operate inside model KV cache — compression is pre-inference text selection. |

Or use the Python client:

```python
from supercompress.client import SuperCompress

sc = SuperCompress()  # SUPERCOMPRESS_API_KEY + default base https://supercompress.dev
out = sc.compress(context, "What matters?", mode="precision")
```

Dashboard & keys: [supercompress.dev/dashboard](https://supercompress.dev/dashboard)

## Local HTTP server (optional)

Development only — **not** used on the public Vercel site.

```bash
pip install -e ".[serve]"
python scripts/local_web_server.py
```

### `GET /api/health`

```json
{"ok": true, "service": "supercompress-web"}
```

### `POST /api/compress`

```json
{
  "context": "long text…",
  "query": "What does fetch return?",
  "compare": true
}
```

Response includes `compressed_text`, token stats, optional `compare` map, and `line_annotations`.

## Train checkpoint

```bash
supercompress-train --fast
python scripts/export_model_json.py   # browser demo weights

# Precision model + verifier
python scripts/train_precision.py     # → web/assets/data/model_precision.json
python scripts/train_verifier.py      # → web/assets/data/verifier.json
```

## Tests

```bash
pytest tests/ -q
# Hard API validation: tests/test_api_hard.py
# Local server: tests/test_local_server.py (needs [serve])
```

## Related docs

- [INTEGRATIONS.md](./INTEGRATIONS.md) — OpenAI, LangChain, browser, curl
- [ENVIRONMENT.md](./ENVIRONMENT.md) — kWh / CO₂ methodology
- [ARCHITECTURE.md](../ARCHITECTURE.md) — policy design
