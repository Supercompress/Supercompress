# SuperCompress roadmap (public)

Last updated: 2026-09-08 · Contributors welcome

Public product + OSS themes. Dates are targets, not promises. Comment on issues to claim work.

## Now

- Coding-agent reliability: Cursor / Claude Code / Codex / Roo / Cline / Grok hooks
- Proxy + MCP edge cases (SSE chunking, detector paths, setup UX)
- Published bakeoffs stay honest vs site copy
- Docs + CONTRIBUTING polish for first-time contributors

## Next

- Better compression quality behind the same API/MCP surface
- More agent plugins with one-command setup
- Benchmark harness outsiders can re-run from the repo
- Gateway / LiteLLM integration docs when ready

## Later

- Team / org dashboard polish
- Enterprise SSO / private cloud (sales-led; not in public OSS by default)
- Community Discord if GitHub volume justifies it

## Where to help

| Area | Good fit if you like… | Start here |
|------|------------------------|------------|
| Proxy / MCP | Node, agent configs, hooks | `packages/proxy`, open `bug` issues |
| CI / release | Scripts, lockfiles, fail-closed checks | `scripts/`, version consistency |
| Docs / site | Clear setup, comparison pages | `web/docs`, `web/supercompress-vs-*` |
| Eval / benches | Honest metrics, reproducibility | `web/assets/data/*benchmark*` |

Label filter: [`good first issue`](https://github.com/Supercompress/Supercompress/labels/good%20first%20issue)

## Community

- **Issues / PRs:** preferred
- **Security:** see `SECURITY.md`
