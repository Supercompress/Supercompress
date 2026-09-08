# Repository layout

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
scripts/             CI + version checks only (no outreach senders)
.github/             Actions, issue templates, funding
```

## Do not commit

| Path | Why |
|------|-----|
| `outreach/`, `PLAN_*`, `GTM_*`, `SEO_*`, `BACKLINK_*` | Private marketing |
| `docs/goals/`, `launch/`, `checkpoints/`, `kaggle/` | Private planning / weights |
| `private/`, `local/`, `*.safetensors`, large `.pt` / `.onnx` | Local R&D / model blobs |
| `api/_lib/weekly-*.json` | Lives in private email-campaigns repo |
| `.env*` | Credentials |

## Where private stuff lives

- Email campaigns: private SuperCompress ops repos
- Unreleased engine / launch planning: private ops (not this tree)
- Training scratch: local only (gitignored)

## Contributor entry points

1. [`CONTRIBUTING.md`](../CONTRIBUTING.md)
2. [`ROADMAP.md`](../ROADMAP.md)
3. Issues labeled `good first issue`
