# Repository layout

Keep the public tree **product-only**. Marketing ops, outreach dumps, training weights, and private email copy do **not** belong here.

```
api/                 Hosted compress API + account/billing (Vercel)
services/neural-keep/ Fly-hosted v4-large cross-encoder (too large for Vercel)
packages/proxy/      Coding-agent plugin (npm: supercompress-proxy)
supercompress/       Python library (PyPI)
web/                 Marketing site + docs HTML (static)
docs/                Longer-form / design docs that are OK public
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
| `scripts/scneural/`, `kaggle/`, `checkpoints/sc-keep-*` | Training / weights |
| `api/_lib/weekly-*.json` | Lives in private `Supercompress/email-campaigns` |
| `.env*`, drain secrets | Credentials |
| `*.safetensors`, large `.pt` | Model blobs |

## Where private stuff lives

- Email campaigns: `Supercompress/email-campaigns` (private)
- Ops / drains: `~/agent-bridge/private/supercompress-email/`
- Neural train scratch: local only (gitignored)

## Contributor entry points

1. [`CONTRIBUTING.md`](../CONTRIBUTING.md)
2. [`ROADMAP.md`](../ROADMAP.md)
3. Issues labeled `good first issue`
