# Fair apples — LIVE SuperCompress API vs Probe0

Generated: 2026-11-16T00:11:03.313Z
Endpoint: `https://www.supercompress.dev/api/v1/compress`

## Important
**Local Fast is not what customers hit.** Live product returned modes: `compiler`; policy: `SuperCompress Log, SuperCompress Compiler, SuperCompress Code`.

## Fair-core bash/tool only

n=51

| Arm | Primary gold | All golds | Cut | p50 ms | Prim misses |
|---|---:|---:|---:|---:|---:|
| supercompress-live | 100% | 100% | 64.1% | 45506.1 | 0 |
| supercompress-fast (local ref) | 100% | 100% | 70.3% | 1.6 | 0 |
| probe0-tool-compact | 100% | 54.9% | 46.2% | 0.3 | 0 |
| truncation-0.35 | 49% | 49% | 66.4% | 0 | 26 |

## Cache-aware USD (fixed prefix)
- raw: $2.49
- live: $1.36 (45.5% vs raw)
- fast local: $1.25
- probe0: $1.68 (32.8% vs raw)

## Victor (live product vs Probe0)

**supercompress-live**

Primary-gold within 2pp (live 100% / Probe0 100%); cut gap 17.9pp: live 64.1% vs Probe0 46.2%
- all-golds diagnostic: live 100% / Probe0 54.9% / trunc 49%
- local Fast is NOT the live product; reported separately for delta only
