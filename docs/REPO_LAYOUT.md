# Repository layout


> **Note (2026-10):** `scripts/` currently also holds benchmarking / training / deploy helpers used by maintainers. The “CI + version checks only” line below is aspirational — treat training weights and private ops as out of OSS publish, but do not assume `scripts/` is empty of bench tooling.

Keep the public tree **product-only**. Marketing ops, outreach dumps, training weights, and private email copy do **not** belong here.

```
api/                 Hosted compress API + account/billing (Vercel)
packages/proxy/      Coding-agent plugin (npm: supercompress-proxy)
supercompress/       Python library (PyPI)
web/                 Marketing site + docs HTML (static)
docs/                Longer-form docs that are OK public
examples/            Small usage examples
integrations/        Third-party snippets
mcp/                 MCP packaging helpers
scripts/             CI, version checks, and maintainer bench/deploy helpers (no outreach senders / private weights)
.github/             Actions, issue templates, funding
```

## Do not commit

| Path | Why |
|------|-----|
| `outreach/`, `PLAN_*`, `GTM_*`, `SEO_*`, `BACKLINK_*` | Private marketing |
| `docs/goals/`, `launch/`, `checkpoints/`, `kaggle/` | Private planning / weights |
| `private/`, `local/`, `*.safetensors`, large `.pt` / `.onnx` | Local R&D / model blobs |
| `api/_lib/weekly-*.json` | Private email campaign content (env-synced) |
| `.env*` | Credentials |
| `games/`, `brand/dither-identity/`, `brand/gauntlet-*` | Local experiments / screenshot dumps |
| `scripts/scneural/`, `scripts/amcp/`, `scripts/gtm_bench/` | Training / bench scratch |
| `scripts/*_blast.js`, `scripts/outreach*` | Private email ops |
| `web/_local-only/` | Local preview HTML |

## Where private stuff lives

- Email campaigns: private SuperCompress ops repos
- Unreleased engine / launch planning: private ops (not this tree)
- Training scratch: local only (gitignored)

## Contributor entry points

1. [`CONTRIBUTING.md`](../CONTRIBUTING.md)
2. [`ROADMAP.md`](../ROADMAP.md)
3. Issues labeled `good first issue`
