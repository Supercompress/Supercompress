# Model card — SuperCompress Neural Keep v2

## Summary
- **Name:** Neural Keep (cross-encoder keep/drop)
- **Size:** ~400M parameters (ModernBERT-large backbone + keep head)
- **Checkpoint (public docs):** `sc-keep-crossencoder-v4-large`
- **Hosted runtime (today):** Fly.io `sc-neural-keep`, **CPU** (`SC_NEURAL_DEVICE=cpu`, shared-cpu-4x / 8GB) — see `services/neural-keep/fly.toml`
- **Weights:** Treated as **private ops assets** for the hosted service (not published in this OSS tree). Local OSS path is the **compiler** engine.
- **Intended use:** Query-aware context compression for coding-agent dumps / RAG before the model call. The **query is never compressed**.

## Evaluation
- Primary public metric: **evidence containment** (required strings survive), not downstream LLM task accuracy.
- B5 coding-agent suite (24 cases): **64.1%** mean cut, **24/24** evidence passes (see `/benchmarks`).
- Full 390-case mix mean cut is much lower (~3.6%) — do not market the B5 cut as universal API-cost savings.
- Some committed artifacts (e.g. fresh6) fail `always_answer_ge_98`; tracked in issue #199.

## Known limitations
- Local compiler `risk` / `important_kept_pct` must reflect pre-repair retention (see compress-engine honesty fix).
- Hosted path serializes inference per instance (`_inflight < 1`) — expect queueing under load.
- Dense needle suites may refuse to cut while still spending seconds — prefer skip-fast paths for production SLOs.

## Privacy
- Hosted MCP/plugin sends context to SuperCompress API (see Privacy Policy; replay/CCR windows apply).
- Legacy `mcp/server.js` is local-compiler-only and must not be described as “same as hosted Neural Keep.”

## License / citation
- Product code: MIT (see `LICENSE`).
- Cite with `CITATION.cff`; do not cite private weight paths from local developer machines.
