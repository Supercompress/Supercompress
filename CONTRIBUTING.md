# Contributing to SuperCompress

Thanks for helping improve SuperCompress. This repo is the open-source prompt compression library, hosted API, and docs site.

## Development setup

Prerequisites:

- **Node.js 22.13 or newer** (npm 10+). The unit tests use the built-in `node:sqlite` module, which Node 20 does not have and earlier Node 22 releases hide behind `--experimental-sqlite`.
- **Python 3.10 or newer**. On Debian/Ubuntu install `python3-venv` if `python3 -m venv` fails.

```bash
# Python package + test/build tools
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

# Node deps (root: API, MCP, tests)
npm ci

# Copy canonical compression assets (web -> packages/proxy & api/_lib).
# The api/_lib copies are gitignored, so a fresh clone needs this before `npm test`.
npm run sync:assets
```

### Running tests

```bash
# All unit tests and repository guards (asset sync, PII, versions, stylesheet paths, API routes)
npm test

# Python tests
pytest -q

# Proxy package test matrix. Each suite runs with a throwaway $HOME, so your real
# Cursor/Claude/Codex configs are not touched. Maintainers doing launch sign-off
# on a machine with a live install can opt in with SC_TEST_LIVE_HOME=1.
npm run test:proxy
```

Re-run `npm run sync:assets` whenever `web/assets/js/compress-engine.js` or `web/assets/data/model.json` changes.

### Local static site

```bash
cd web && python3 -m http.server 8080
# open http://127.0.0.1:8080
```

### Local compress API + site (optional)

Needs the `serve` extra (FastAPI/uvicorn):

```bash
pip install -e ".[dev,serve]"
python scripts/local_web_server.py   # http://127.0.0.1:8790 (override with PORT=...)
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
