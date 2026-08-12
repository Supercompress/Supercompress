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
- GitHub Sponsors on the Supercompress repo (`FUNDING.yml` + Sponsor badge) → [@arjunkshah12345-hash](https://github.com/sponsors/arjunkshah12345-hash)
- Product mail campaign copy lives in private GitHub `Supercompress/email-campaigns` (not OSS); loaders read Vercel env / local mirror
- Product mail (welcome + Sunday tip + Wednesday ship) sends from Resend on `hello@supercompress.dev`; Ideatrusa/gog drains paused offline
- Remove weekly tip/ship campaign JSON from the OSS tree (private content dir + `WEEKLY_*_JSON` env)
- Sync public npm pins to `supercompress-proxy@0.5.18`; extend `check-versions.js` to gate those pins
- Remove leftover Analytics spark DOM + unused series helpers from dashboard
- Keep user emails / outreach dumps / welcome-drain ops **out of OSS** (gitignore + CI PII gate); drain scripts live under `~/agent-bridge/private/supercompress-email/`

### API / dashboard
- **Resend inbound webhook:** `POST https://www.supercompress.dev/api/resend/webhook` (Svix-verified `email.received` → `inbound_mail` + notify)
- Auto branded **power-user email** when someone *newly* crosses 1M tokens (once ever; no backfill of current 1M+ accounts)
- **Dashboard Analytics panel** (dither charts): live usage from `/api/keys` after sign-in — tokens saved, requests, coding agents, and key breakdown. `/analytics` stays inside `/dashboard?panel=analytics`.
- Fix Analytics chart paint: Bayer wells + stacked dither canvases, wait for layout before draw, no demo/fake flash on production.
- Align `/api/account?op=usage` + dashboard `account_usage` with the billing ledger (CLI no longer under-counts vs dashboard)
- Idempotent compress: replay stored response for same Idempotency-Key + fingerprint (no free recompute)
- Durable IP rate limit counts each client key (not payload fingerprint alone)
- Billing idempotency ignores `X-Request-Id` (tracing ≠ Idempotency-Key)
- Durable per-key usage metering + dashboard KPI preference for billing meter
- Remove dead store Auth-stub helpers; CCR uses Firestore (docs match)
- Fix demo CO₂ grams over-count (`×1000` bug)
- Transactional Firestore billing ledger for usage + wallet burns; Stripe auto-recharge lock + idempotency; no pre-Checkout `sc_metered` mutation; micro-USD burns so tiny requests are not free
- Fix `/api/v1/compress` 504s: kill O(n²) token-entropy scans in the engine, skip unused line annotations on the hosted path, soft-timeout Firestore side-effects, raise route `maxDuration` to 60s
- Harden billing: fail-closed `recordUsage`, atomic free-quota/wallet rejection (no clamp-to-zero), permanent `billing_credits/{id}` idempotency, ledger-only claim mirroring
- Compress POST-only (no query API keys/context); durable rate-limit fail-closed; CCR strips retrieve markers if persistence fails; dashboard reads billing ledger
- **Request-level billing idempotency** (`billing_usage/{uid}:{requestId}` + `Idempotency-Key`) so billing timeouts cannot double-charge on retry
- Bill before per-key analytics; skip analytics on idempotent replay
- Auto-recharge once when balance is positive but insufficient, then retry the same request id
- First-pay bonus create-once via `billing_bonus/{uid}:first_pay`; honest Checkout replay (`already: true`, `creditUsd: 0`)
- Cumulative micro-USD rounding (`ceil(totalAfter) − ceil(totalBefore)`); idempotent durable rate-limit hits
- **Bind Idempotency-Key to a server SHA-256 payload fingerprint** — reused key with a different compress body returns `409 idempotency_conflict` (not free recompress)
- Durable hourly rate-limit hits use the **payload fingerprint**, not the client-chosen request id (stops limit evasion)

### Coding agent plugin
- Register/unregister the proxy service via `execFileSync` argv (no shell-interpolated `launchctl` / `systemctl` paths)
- **`supercompress` TUI** (`0.5.19`): paper-branded interactive UI (usage / account / connect / setup / plugin / agents / proxy). Default in a TTY; needs Bun. Classic commands unchanged.
- **OpenClaw auto-compress parity with Hermes**: `supercompress setup` / `plugin` wires MCP (absolute node+mcp), `AGENTS.md`, managed skill, internal hooks (`agent:bootstrap` + `session:compact:before`), and an extension plugin that compresses large tool dumps into the inbox
- **Session-scoped OpenClaw inbox** (`inbox/<sessionId>/latest.md`) so sessions/projects cannot cross-contaminate digests; honor `SUPERCOMPRESS_CONFIG_DIR`
- OpenClaw plugin path install/uninstall uses **exact absolute path** equality (no substring deletes of `extensions/supercompress-*`)
- Real `compactSessionMemory()` for OpenClaw `compact:before` (no empty-context no-op)
- Chunk tool dumps into ≤120k API blocks; hooks send stable `Idempotency-Key` = hash(session + content + mode)
- Protocol/runtime safety: native `fetch` (drop `node-fetch`), owned-PID-only stop, buffered SSE that preserves `tool_calls`, skip compression for structured tool/Responses items, inject digests as user (not system), fail-open on compress timeout/5xx, block browser `Origin` on local proxy, zstd size caps, spawn via `process.execPath`
- Non-destructive setup: only clear SuperCompress-owned base URLs; backup before plugin writers; fix instruction-block idempotency; don’t markSeen on compress timeout/error; don’t split long asks without paragraph breaks; secure inbox/session modes; fail connect instead of rotating production API keys; atomic device-link consume via Firestore
- **Preserve tool-call / tool-result order** when splitting compressible history (no reverse via `unshift`)
- Rank structured-history compression against the **latest user ask in the full thread**, not an older compressible-prefix turn
- Send `Idempotency-Key` on compress API calls for safer retries
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
