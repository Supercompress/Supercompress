# Changelog

All notable changes to SuperCompress are documented here.

The format is inspired by [Keep a Changelog](https://keepachangelog.com/).
Versions below track the **coding-agent plugin** (`supercompress-proxy` on npm) unless noted otherwise.
Product site + API ship continuously from `main`.

Releases: https://github.com/Supercompress/Supercompress/releases  
Public page: https://www.supercompress.dev/changelog

---

## [Unreleased]

### Site / docs
- Sync public npm pins to `supercompress-proxy@0.5.17`; extend `check-versions.js` to gate those pins
- Remove leftover Analytics spark DOM + unused series helpers from dashboard

### Python library
- Shared `CompressResult` for local + hosted client (`supercompress.result`)
- Honest `mode="precision"` (hosted API when keyed; otherwise raises)
- Validate `budget_ratio` in `(0, 1]`; empty context returns `noop`
- Stop appending the user query onto local `compressed_text`
- Remove import-time warning when no API key is set
- Fix OpenAI / LangChain / Anthropic integration examples and middleware contracts
- `serve` extra installs FastAPI + Uvicorn (not Flask/Gunicorn); add `py.typed`

### API / dashboard
- Durable per-key usage metering + dashboard KPI preference for billing meter
- Remove dead store Auth-stub helpers; CCR uses Firestore (docs match)
- Fix demo CO₂ grams over-count (`×1000` bug)

### Coding agent plugin
- See **[0.5.17](#0517--2026-08-10)** / **[0.5.16](#0516--2026-08-09)** below

### Repository hygiene
- Remove Fly/Docker/Render deploy debris (Vercel-only production)
- Delete unused frontend CSS/JS; drop duplicate tracked `launch.mp4`
- Remove unused `openfork` dependency; strengthen GitHub CI smoke tests
- Host redirects for `internal` / `arjun` → `/dashboard`
- Homepage: stop preloading hero MP4; `preload="metadata"` on video

---

## [0.5.17] — 2026-08-10

### Coding agent plugin (`supercompress-proxy`)

- **Fix agent attribution**: Cursor postToolUse no longer mislabels usage as `claude_code`
- Cursor hooks set `SUPERCOMPRESS_AGENT_NAME=Cursor` explicitly
- Stop using `configured_agents[0]` as the compress agent name

---

## [0.5.16] — 2026-08-09

### Coding agent plugin (`supercompress-proxy`)

- **Hard paywall surfacing**: hooks + MCP no longer silently fail-open on HTTP 402
- Loud `[SuperCompress PAYWALL]` CTA; proxy returns 402 with billing URL
- Restore missing `compressIncremental` export used by MCP `compress_context`

---

## [0.5.7] — 2026-08-01

### Coding agent plugin (`supercompress-proxy`)

- **Auto across agents:** `supercompress plugin` / `setup` installs MCP on every detected host (Cursor, Claude, Codex, OpenCode, FreeBuff, Windsurf, Continue, Gemini, Goose, Crush, Amp, Zed, Copilot, Roo, Cline, …).
- **Claude Code + Codex:** `UserPromptSubmit` + `PostToolUse` hooks for every-message + large tool-dump auto-compress.
- **Cursor:** every-message inbox + broader `postToolUse` matchers; always-on rule kept.
- **Always-on instructions** written for Claude / Codex / Aider / Goose / OpenCode when present.
- **`supercompress wrap <agent>`** — Headroom-style proxy launch (`claude`, `codex`, `aider`, `opencode`, `gemini`, …) so *all traffic* is auto-compressed.

### Repository & site

- Public source of truth on [github.com/Supercompress/Supercompress](https://github.com/Supercompress/Supercompress).
- Product site, docs, and package metadata link to GitHub; GitLab kept as a private CI mirror.
- Changelog page + shared landing footer across site pages.

---

## [0.5.6] — 2026-07-31

### Coding agent plugin (`supercompress-proxy`)

- Every-message compress threshold lowered (compress prompts ≥40 chars; tiny ones still write inbox).

---

## [0.5.5] — 2026-07-31

### Coding agent plugin

- **Every-message auto-compress**: IDE `beforeSubmitPrompt` writes `~/.supercompress/inbox/latest.md` on every submit; Claude Code + Codex `UserPromptSubmit` inject compressed digests; `postToolUse` threshold lowered to 800 chars.
- Always-on agent rule forces Read of inbox digest first every turn.

---

## [0.5.4] — 2026-07-28

### Coding agent plugin

- OpenCode MCP: write `enabled: true`, `timeout: 60000`, and `experimental.mcp_timeout` (OpenCode’s default tool-fetch timeout is 5s). Prefer `supercompress-mcp` on PATH over a baked absolute Node path.

---

## [0.5.3] — 2026-07-28

### Coding agent plugin

- Harden MCP stdio server against `-32000: Connection closed`: catch unhandled errors, keep process alive on tool failures, timeouts on API calls, stderr-only logging, drop unused elicitation capability.

---

## [0.5.2] — 2026-07-26

### Coding agent plugin

- Ship LICENSE + CHANGELOG in the npm tarball.

---

## [0.5.1] — 2026-07-26

### Coding agent plugin

- **postinstall is guidance-only** — no longer rewrites agent MCP configs on `npm install`. Use `supercompress setup` or `supercompress plugin`.
- **FreeBuff dual-launch** — MCP compress handshake waits for tool responses (no early timeout flake).
- Docs/README aligned with MCP-first install path; agent catalog count 49.

---

## [0.5.0] — 2026-07-26

### Coding agent plugin

- MCP-first coding-agent plugin (`compress_context`, `connect_account`, `usage_summary`).
- Optional localhost API proxy via `supercompress setup --proxy`.
- Hard launch of SuperCompress coding agent integrations (Cursor, Claude Code, Codex, and more).

---

## Links

- [GitHub releases](https://github.com/Supercompress/Supercompress/releases)
- [npm: supercompress-proxy](https://www.npmjs.com/package/supercompress-proxy)
- [Coding agents docs](https://docs.supercompress.dev/coding-agents)
