# Fair apples — multi-competitor (live + Headroom + Caveman Cloud)

Generated: 2026-11-16T00:25:00.177Z
Corpus: fair-core bash/tool only, n=51

## Results

| Arm | Primary gold | All golds | Cut | Cache USD | p50 ms | Errors |
|---|---:|---:|---:|---:|---:|---:|
| supercompress-live | 100% | 100% | 64.1% | $1.36 | 45506.1 | 0 |
| caveman-cloud | 100% | 100% | 0% | $2.49 | 320.7 | 0 |
| headroom-kompress | 98% | 51% | 14.2% | $2.24 | 1078.4 | 0 |
| litellm-local | 9.8% | 7.8% | 41.6% | $1.76 | 1.3 | 0 |
| probe0-tool-compact | 100% | 54.9% | 46.2% | $1.68 | 0.4 | 0 |
| supercompress-fast | 100% | 100% | 70.3% | $1.25 | 1.9 | 0 |
| truncation-0.35 | 49% | 49% | 66.4% | $1.32 | 0 | 0 |
| raw (no compress) | 100% | 100% | 0% | $2.49 | — | 0 |

## Ranking (live-product contest; Fast excluded from ranks)

| Rank | Arm | Primary gold | Cut | Cache USD |
|---:|---|---:|---:|---:|
| 1 | supercompress-live | 100% | 64.1% | $1.36 |
| 2 | probe0-tool-compact | 100% | 46.2% | $1.68 |
| 3 | headroom-kompress | 98% | 14.2% | $2.24 |
| 4 | caveman-cloud | 100% | 0% | $2.49 |
| 5 | litellm-local | 9.8% | 41.6% | $1.76 |

## Winner: **supercompress-live**

Rule: among zero-error non-truncation arms (Fast excluded), higher primary-gold (>2pp), else higher cut (>2pp), else lower cache USD.

## Scope honesty
- Caveman Cloud contract takes input only (no query).
- SuperCompress live and Headroom/LiteLLM/Probe0 receive the query.
- Local Fast is a reference delta, not the customer API.
- Probe0 still owns cache-TTL / routing / spend caps outside this job.
- Caveman Cloud previously measured as passthrough on some accounts; this run reports measured cut on this key.
