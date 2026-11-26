# route-bench

Scores `model: "auto"` routing decisions against what real models actually got right. It uses the same rules as [compress-bench](https://github.com/Supercompress/compress-bench): tune on dev only, score the held-out splits once per router version, and publish what comes out.

## Data

This benchmark uses [RouterBench](https://huggingface.co/datasets/withmartian/routerbench) 0-shot: 36,497 prompts, each with the recorded score and cost of 11 models. It is not redistributed here. To build the local JSONL:

1. Download `routerbench_0shot.pkl`.
2. Load it with an unpickler restricted to the pandas/numpy reconstruction classes. Never load a downloaded pickle with plain `pickle.load`.
3. Write one JSON object per line: `{id, eval, prompt, score: {model: s}, cost: {model: usd}}`.

Point `ROUTERBENCH_JSONL` at the file. The default is `~/Downloads/sc-bench-local/routerbench/routerbench_0shot.jsonl`.

## Task and metrics

For each prompt, the router picks the strong model (GPT-4-1106) or the weak model (Mixtral-8x7B). Quality is the recorded score of the model it picked. No model calls are made.

Each router's threshold is swept from 0% to 100% strong calls (RouteLLM metrics):

- **PGR(k):** the share of the weak→strong quality gap recovered at k% strong calls.
- **APGR:** the mean of PGR over k. Random routing scores 0.5; higher is better.
- **CPT(80%):** the share of calls that must go to the strong model to recover 80% of the gap. Lower is better.
- **cost@CPT80:** list cost at that point, relative to sending everything to the strong model.

95% CIs come from 200 prompt-bootstrap resamples.

## Splits

| Split | What | Rule |
|---|---|---|
| `dev` | Half of MMLU, HellaSwag, GSM8K, ARC, Winogrande (salted hash of the prompt id) | Train and tune here only |
| `test` | The other half | Score once per router version |
| `external` | Every other family: MBPP code, MT-Bench, summaries, Chinese tasks, … | Never tuned on; tests task kinds the router never saw |

## Arms

| Arm | What |
|---|---|
| `sc-router` | The shipped classifier (`packages/control-plane/request-classifier.js`). Task rules apply to recognised asks; the learned difficulty model handles unrecognised ones, and asks under 200 characters cannot reach the reasoning tier. Its tier is the score. |
| `learned-only` | `packages/control-plane/difficulty-model.js` on its own. Logistic regression over hashed word/bigram features, trained on dev with `train.js` (settings chosen on an inner 20% of dev). |
| `length` | Prompt length. |
| `random` | Constant score. |
| `oracle` | Strong-minus-weak score, the ceiling. |

## Results (2026-11-25)

The held-out splits were scored once per router version.

| Split | n | rules only (before) | **sc-router (shipped)** | learned-only | length | random |
|---|---:|---:|---:|---:|---:|---:|
| dev | 17,009 | 0.474 | 0.664 | 0.753 | 0.555 | 0.5 |
| test | 17,262 | 0.477 | **0.598** (0.592–0.606) | 0.651 (0.643–0.660) | 0.544 | 0.5 |
| external | 2,226 | 0.458 | **0.454** (0.409–0.494) | 0.655 (0.608–0.717) | 0.321 | 0.5 |

On the external families, `learned-only` reaches 80% of the quality gap with 56% strong calls, at 58% of the always-strong cost.

What this shows, including where it hurts:

- **The rule classifier alone routed general prompts slightly worse than chance.** Its patterns describe coding-agent work, and general questions trip them by accident.
- **The shipped router is now clearly better than chance on in-distribution prompts (0.598 vs 0.5), but not on the external families (0.454).** Those prompts (MBPP "write a function", for example) match the coding rules, so the learned model never sees them. That is deliberate for agent traffic, which the rules were built and tested for (see `../bench_router_autorouter`: 18/18 turns and 56/59 held-out prompts, unchanged). It does mean general, non-agent traffic is routed better by `learned-only`.
- **RouterBench is not coding-agent traffic.** It has no tool loops and few prompts under 270 characters. The learned model is not allowed to send short asks to the reasoning tier for that reason.

## Commands

```bash
node scripts/bench_router_routerbench/run.js [--split dev|test|external] [--json]
node scripts/bench_router_routerbench/train.js --tune   # dev only
node scripts/bench_router_routerbench/train.js --buckets 262144 --epochs 2 --lr 1 --l2 0.00001
```
