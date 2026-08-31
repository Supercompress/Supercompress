# Contributing to SuperCompress

Thanks for helping improve SuperCompress. This repo is the open-source prompt compression library, hosted API, and docs site.

## Development setup

```bash
# Python package
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]" 2>/dev/null || pip install -r requirements.txt
pip install -e .

# Optional: Node deps for MCP / proxy packages
npm install
```

### Local static site

```bash
cd web && python -m http.server 8080
# open http://127.0.0.1:8080
```

### Local compress API (optional)

```bash
python scripts/local_web_server.py
```

### Running tests

```bash
# Run all unit tests and repository guards (asset sync, PII, versions, stylesheet paths, API routes)
npm test

# Run proxy package test matrix
npm run test:proxy

# Sync canonical compression assets (web -> packages/proxy & api/_lib)
npm run sync:assets
```

### Proxy package

```bash
cd packages/proxy && npm install && node bin/supercompress.js --help
```

## What belongs in this repo

- Compression engine (`supercompress/`)
- Hosted API (`api/`)
- Product site pages (landing, dashboard, playground, docs, core guides)
- Integrations, examples, MCP server, proxy package

Please keep marketing ops, outreach lists, SEO page farms, and private planning docs out of PRs.

## Pull requests

1. Fork and create a focused branch.
2. Prefer small PRs with a clear problem statement.
3. Add or update tests/benchmarks when changing compression behavior.
4. Do not commit secrets, `.env*` files, or large binaries (`.mp4`).

## Roadmap & community

- Public roadmap: [ROADMAP.md](./ROADMAP.md)
- Prefer GitHub Issues / PRs (no Discord yet)
- Look for the `good first issue` label

High-impact areas right now: `packages/proxy` (agent detection, hooks, SSE), CI/version locks, docs/setup copy, and honest benchmark/site sync ([#130](https://github.com/Supercompress/Supercompress/issues/130)).

## Reporting bugs

Open an issue on [github.com/Supercompress/Supercompress/issues](https://github.com/Supercompress/Supercompress/issues) with:

- Expected vs actual behavior
- Minimal reproduction (context + query)
- Package / API version

## Security

See [SECURITY.md](SECURITY.md) for private disclosure.
