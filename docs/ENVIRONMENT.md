# Environmental impact methodology

SuperCompress compresses **prompt text before inference**. It does **not** read, write, or evict inside the model's KV cache. Fewer input tokens means less prefill work on the provider/GPU for the same workflow — that is an *effect* of shorter prompts, not in-KV compression.

These numbers are **illustrative estimates**, not per-deployment measurements. All assumptions are explicit so judges and operators can adjust them.

## What we measure

| Metric | Definition |
|--------|------------|
| **Tokens saved** | `original_tokens − kept_tokens` per compression |
| **Token savings %** (`tokens_saved_pct`) | `(1 − kept/original) × 100` — percent of **prompt tokens removed**, not a KV-cache operation |
| **GPU-seconds avoided** | Effective tokens saved ÷ throughput |
| **Wh saved** | GPU-seconds × GPU watts ÷ 3600 |
| **CO₂ avoided** | Wh × grid intensity (kg/kWh) ÷ 1000 |

## Default assumptions

Defined in `supercompress/benchmarks/metrics.py`:

| Parameter | Default | Rationale |
|-----------|---------|-----------|
| `tokens_per_gpu_second` | 2,500 | 7B-class prefill on consumer GPU |
| `gpu_watts` | 150 W | Typical single-GPU draw during inference |
| `context_share_of_prefill` | 55% | Attribution: share of prefill cost treated as context-driven (not "we edit KV") |
| `grid_kg_co2_per_kwh` | 0.417 | US grid average (EIA) |

## Python API

```python
from supercompress.benchmarks.metrics import sustainability_from_tokens_saved

tokens_saved = result.original_tokens - result.kept_tokens
impact = sustainability_from_tokens_saved(tokens_saved)

print(impact.watt_hours_saved, impact.co2_kg_avoided)
print(impact.assumptions.to_dict())
```

## Why CPU eviction matters

The learned policy (a learned query-aware neural policy) runs on **CPU before GPU inference**. Eviction adds sub-millisecond latency while avoiding much larger GPU prefill cost on long contexts.

## Scale example (1M compressions)

At ~800 tokens saved per run:

- **800M tokens** avoided
- **~29 kWh** saved (default assumptions)
- **~12 kg CO₂** avoided (US grid)

Use the website **Projection calculator** (`#impact`) to adjust volume.

## Honesty for submissions

1. State assumptions clearly — do not claim live metering unless you have it.
2. Compare **quality + savings** together (truncation can save tokens but drop answers).
3. SuperCompress targets **edge-CPU policy + measurable prompt-token reduction before inference** — not in-KV compression or datacenter-wide carbon accounting.

## Neural reranker (hosted input quality)

Hosted compression can use a BGE cross-encoder on Fly/local (not Vercel cold starts). The offline plugin stays heuristic-only unless it calls the hosted API.

| Variable | Default | Description |
|----------|---------|-------------|
| `SC_NEURAL` | auto | `1` force on, `0` force off; auto-on when model is cached |
| `SC_RERANKER_MODEL` | `onnx-community/bge-reranker-v2-m3-ONNX` | Hugging Face model id |
| `SC_RERANKER_DTYPE` | `q8` | ONNX dtype (`q8` / `int8` / `q4` / `fp32`) |
| `SC_RERANKER_MAX_BLOCKS` | `128` | Max blocks scored per request |
| `SC_MODEL_DIR` | `<repo>/models` | Transformers.js cache root |

Warmup / download:

```bash
SC_NEURAL=1 node scripts/warmup_neural.js
```

See also [Architecture](https://docs.supercompress.dev/architecture) for deployment modes.
