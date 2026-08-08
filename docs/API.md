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
    question="What does fetch return when the row is missing?",
)

print(result.compressed_text)       # send to your LLM
print(result.tokens_saved_pct)        # tokens removed before your LLM call
print(result.original_tokens, result.kept_tokens)
```

The hosted API does not require a budget. It uses compiler mode by default: maximize tokens removed while keeping important query evidence.

```bash
export SUPERCOMPRESS_API_KEY=sc_live_YOUR_KEY

curl -X POST https://www.supercompress.dev/api/v1/compress \
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
result = compress_context(text, question)  # auto-compiler
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
result = compress_context(text, question, budget_ratio=0.35)
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
result = compress_context(text, question)
print(f"Preprocessor: {result.preprocessor}")  # "json", "code", "log", or "none"
```

## CCR — Cache, Compress, Retrieve

Reversible compression: removed blocks are replaced with retrieval markers. The original content can be restored on demand.

```bash
# Request compression with CCR
curl -X POST https://www.supercompress.dev/api/v1/compress \
  -H "X-API-Key: sc_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"context": "long text…", "query": "What matters?", "ccr": true}'

# Response includes ccr field (when storage succeeds):
# {
#   "compressed_text": "... [SC-Retrieve: a1b2c3d4] ...",
#   "ccr": {
#     "hash": "a1b2c3d4e5f6_1a2b",
#     "marker_hashes": ["..."],
#     "markers_count": 3,
#     "retrieve_url": "/retrieve?hash=a1b2c3d4e5f6_1a2b"
#   }
# }

# Retrieve original (same API key as compress)
curl "https://www.supercompress.dev/api/retrieve?hash=a1b2c3d4e5f6_1a2b" \
  -H "X-API-Key: sc_live_YOUR_KEY"
```

### Browser-side CCR

```javascript
const result = SuperCompressEngine.compressCCR(context, query, model, { enableMarkers: true });
// result.compressed_text contains [SC-Retrieve: hash] markers
// Use SuperCompressEngine.ccrRetrieve(hash) to get original
```

## Functions

### `compress_context(text, question, budget_ratio=0.35, policy=None, checkpoint=None)`

Compress a single string. Returns `CompressResult`.

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `text` | str | required | Full context to trim |
| `question` | str | required | Current user query — drives retention |
| `budget_ratio` | float | `0.35` | Fraction of tokens to keep, `(0, 1]` (fixed-ratio mode only) |
| `policy` | `EvictionPolicy` | learned | Override with `FIFO()`, `TruncationPolicy()`, etc. |
| `checkpoint` | str | `default.pt` | Path to trained weights |

**Raises:** `ValueError` if `budget_ratio` ∉ `(0, 1]`.

**Empty input:** returns `policy_name="noop"` with zero tokens.

### `compress_for_turn(context_blocks, user_query, budget_ratio=0.35)`

Merge blocks with `\n\n---\n\n`, then compress. Returns `(compressed_text, CompressResult)`.

```python
compressed, stats = compress_for_turn(
    ["## Notes\n…", "## Code\n…"],
    "Summarize the API",
)
```

### `compare_policies(text, question, budget_ratio=0.35)`

Returns `dict[str, CompressResult]` for FIFO, Truncation, Summarization, H2O, and SuperCompress.

```python
for name, r in compare_policies(ctx, question).items():
    print(name, r.kept_tokens, f"{r.tokens_saved_pct:.1f}%")
```

### `compress_detailed(text, question, ...)`

Same as `compress_context`, plus `List[LineAnnotation]` with per-line keep/drop reasons.

```python
result, lines = compress_detailed(ctx, question)
for ln in lines:
    if not ln.kept:
        print(ln.line_index, ln.reason)
```

### `middle_truncation_failure_case()`

Returns `(context, question)` where head+tail truncation loses a middle answer — use for demos and tests.

## `CompressResult`

| Field | Type | Description |
|-------|------|-------------|
| `original_text` | str | Input context |
| `compressed_text` | str | Trimmed context for your LLM |
| `original_tokens` | int | Tokens before eviction |
| `kept_tokens` | int | Tokens retained |
| `tokens_saved_pct` | float | `(1 - kept/original) × 100` |
| `compression_ratio` | float | Property: `original / kept` |
| `policy_name` | str | `SuperCompress`, `H2O-fallback`, or baseline name |
| `budget_ratio` | float | Retention budget used |
| `preprocessor` | str | `json`, `code`, `log`, or `none` |
| `kept_line_ratio` | float | Share of lines kept (includes sink/recent) |
| `question` | str | Query used |

## Environmental impact

```python
from supercompress.benchmarks.metrics import sustainability_from_tokens_saved

saved = result.original_tokens - result.kept_tokens
impact = sustainability_from_tokens_saved(saved)
print(impact.to_dict())
```

See [ENVIRONMENT.md](./ENVIRONMENT.md) for assumptions.

## Hosted API (production)

Use `POST https://www.supercompress.dev/api/v1/compress` with `context` and `query`. Omit `budget_ratio` unless you want legacy fixed-ratio mode (`mode: "fixed"`).

**Auth:** `X-API-Key: sc_live_…`, or `Authorization: Bearer sc_live_…`, or `?api_key=` on GET (discouraged for production).

**Limits:** 90 requests/minute per API key; 600 requests/hour per client IP. `context` max 120,000 characters.

Optional JSON body fields:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | str | `"Summarize this context."` | Current user question — never compressed |
| `mode` | str | `"compiler"` | `"compiler"` (adaptive) or `"fixed"` (explicit `budget_ratio`) |
| `budget_ratio` | float | `0.35` | Keep ratio for `mode: "fixed"` only (0.05–1) |
| `ccr` | bool | `false` | Reversible compression (markers + blob storage) |
| `cache_prefix` | bool | `false` | Wrap output for provider prompt/prefix cache (pre-inference text only) |
| `coding_agent` | str | — | Label for agent usage analytics |
| `source` | str | inferred | Override usage source (`api`, `agent`, …) |
| `session_id` | str | — | Correlate logs across turns |
| `log` | bool | `true` | Set `false` to skip activity log previews |

Success (`200`) includes `compressed_text`, token counts, `tokens_saved`, `tokens_saved_pct`, `compression_risk`, `kept_blocks` / `dropped_blocks`, and `latency_ms`. Paywall responses use HTTP `402` with `paywall: true` and `code` `free_quota_exhausted` or `credits_exhausted`.

`GET` with the same query params is supported for quick tests; production clients should use `POST`.

**Precision mode** is available in the **local Python library** and browser demo. The hosted `/api/v1/compress` route accepts `mode: "compiler"` (default, adaptive) or `mode: "fixed"` with `budget_ratio`.

```python
from supercompress import compress_context

# local library — precision search + verifier (see Precision mode above)
result = compress_context(text, question)  # or SuperCompress client with mode="precision" against a self-hosted stack
```

Dashboard & keys: [www.supercompress.dev/dashboard](https://www.supercompress.dev/dashboard)

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
- [Architecture](https://docs.supercompress.dev/architecture) — policy design
