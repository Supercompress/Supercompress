# Changelog

Versions track `supercompress-proxy` on npm. Full product notes: [CHANGELOG.md](../../CHANGELOG.md) · [GitHub Releases](https://github.com/Supercompress/Supercompress/releases)

## [Unreleased]

### Added
- **Public limitcheck counter.** Each runway check (`supercompress limits` status or the MCP tool `runway_check`) sends one anonymous count to [limitcheck.supercompress.dev](https://limitcheck.supercompress.dev/live), which shows the global total live. The body is only the verdict (`go` / `land` / `pace` / `wait` / `unknown`) and `cli` or `mcp`: no ids, usage numbers, prompts or paths. Statusline updates and `limits ingest` never count. The ping times out after 1.5 s and never fails a check. Opt out with `SUPERCOMPRESS_TELEMETRY=0`, `DO_NOT_TRACK=1` or `SUPERCOMPRESS_RUNWAY=0`.

### Fixed
- **`compress_context` no longer returns more than it was given.** It returned the whole rolling session memory, twice (`compressed_context` and `compressed_text`), so small inputs came back larger than they went in, and inputs under 40 characters returned all of the memory. It now returns this call's digest once. When there is nothing to gain, it returns a one-line passthrough notice instead of echoing the text.
- **`query` is optional.** Omit it to shrink a raw dump; the API compresses in dump mode. Session compaction without an ask uses dump mode too.
- **Warnings reach the agent.** Deep-cut and free-quota warnings from the API appear as `warning` and `quota_warning`, first in the result. `usage_summary` warns when the free tier is used up.

## [0.5.40] — 2026-10-22

### Added
- **Runway: local rate-limit checks for coding agents.** `supercompress limits [--json]` and the MCP tool `runway_check` tell the agent how much provider quota is left (5h / weekly / monthly windows) and what to do with it: `go`, `land`, `wait`, or `unknown`. Runway runs locally and ships in this package; nothing goes through the hosted API.
  - Sources: Codex session telemetry (no setup needed), Claude Code's statusline `rate_limits`, rate-limit headers the local proxy sees (Anthropic, OpenAI-compatible, xAI, OpenRouter, Codex, plus `retry-after` on 429), and `supercompress limits ingest` for any other harness.
  - The default `max` policy uses a 5h window all the way to the provider's cutoff instead of stopping at a fixed 10% floor. Short windows reset on their own, so unused quota is lost. Near the end the agent "lands": it keeps working but commits or writes a handoff note before each step. Weekly and monthly windows are judged by pace. `--policy conservative` keeps the classic 25% / 10% thresholds.
  - `setup` / `plugin` wire it automatically. They copy a standalone runtime to `~/.supercompress/runway/` and connect Claude Code's statusline as `(tee || cat) | <your statusline>`, so your statusline keeps working unchanged. `uninstall` restores it. `SUPERCOMPRESS_RUNWAY=0` opts out.
  - Never answers one agent with another agent's quota, and never invents a limit.

### Changed
- **Clearer agent instructions everywhere** (CLAUDE.md / AGENTS.md blocks, Cursor rule, fx, Grok, Hermes / OpenClaw, skills, session-start hook, MCP tool descriptions). Instructions are now built from one shared source, with concrete triggers ("diffs over ~150 lines / ~2K tokens", logs, test runs, long file reads, search results, docs). They also say what not to compress (the request, and code you are about to edit), to re-read the source when the digest drops a needed line, and to hand the user the `connect_account` link.
- The marketplace plugin skill points agents at the local `supercompress limits --json` for rate limits, since the hosted MCP has no runway tool.

## [0.5.39] — 2026-10-20

### Added
- **Grok Bot** in CLI auto-detect / auto-plugin: `setup` and `plugin` always write a paste-ready hosted MCP snippet (`Add this MCP server: https://www.supercompress.dev/api/mcp`) under `~/.supercompress/hosts/grok-bot/` and list Grok Bot with other auto MCP hosts.

### Fixed
- **uninstall no longer wipes MCP servers / settings added after install.** Only SuperCompress's own entries are removed; every other config is edited in place (TOML/JSON/JSONC/YAML formatting and comments preserved). Previously every backed-up file except JSON with an `mcpServers`/`mcp` key was rewound to its install-time snapshot (Codex and Grok Build `config.toml`, Gemini/Zed/Continue/Goose/Hermes/OpenClaw configs), and configs setup had created were deleted outright.
- Overwritten settings (provider base URLs, Grok `[mcp] max_output_bytes`, shell-profile `ANTHROPIC_BASE_URL`) are restored key-by-key from the pre-install value, and only while they still hold SuperCompress's value.
- Missing or malformed configs are skipped (no crash, never overwritten with `{}`).

## [0.5.37] — 2026-09-30

### Fixed
- Plugin `.mcp.json` no longer injects `Authorization` / required API key; MCP 401 on `initialize` for OAuth prompt; no `?key=` on `/api/mcp`.

## [0.5.36] — 2026-09-30

- **MCP OAuth 2.1 (PKCE)** on hosted `/api/mcp`: well-known discovery, DCR, authorize → Google dashboard sign-in, token exchange. Access tokens are real `sc_live_…` keys.
- Hosted MCP returns **401 + WWW-Authenticate** when tools need auth (triggers browser OAuth).
- Marketplace plugin `mcp.json` is OAuth-first (no required pre-pasted key). CLI device-link unchanged.
- Claim hygiene: `/benchmarks` is v2 launch suite; Neural vs Compiler split on homepage; 40+ harnesses; evidence-containment language.

## [0.5.35] — 2026-09-30

- **kept_tokens**: hosted Neural Keep path now returns `kept_tokens` (and `compressed_tokens`) so MCP usage / billing no longer show 0 kept / 100% savings.
- **uninstall**: shared MCP configs (`~/.claude.json`, etc.) are surgically stripped — never fully restored from install-time backup — so MCP servers added after setup survive.
- Claude / Cursor marketplace plugin copy: 64.1% / 24/24 + ~400M Neural Keep (was stale 64%/24/24).

## [0.5.32] — 2026-09-30

- **v2 live**: hosted ~400M Neural Keep (query-aware). Coding-agent B5: **64.1%** mean cut, **24/24** evidence, 16,647 → 5,148 tokens.
- Launch promo copy: **5M free / mo**, then **$0.10 / 1M** (paywall + README aligned).
- **Grok Bot plugin**: hosted Streamable HTTP MCP at `https://www.supercompress.dev/api/mcp` (cloud-reachable). Cursor/marketplace pack uses remote URL + `SUPERCOMPRESS_API_KEY`. Chat install: `Add this MCP server: https://www.supercompress.dev/api/mcp`.

## [0.5.31] — 2026-09-30

- **50+ harness plugin story**: catalog expanded; `agents` / `doctor` / docs surface auto-plugin vs recipe.
- **Native writers**: Goose YAML `extensions.supercompress`; Continue `experimental.modelContextProtocolServers` (no more Cursor-shaped `mcpServers` in Continue); Claude Desktop; Pi / Void / PearAI / Crush / Amp / Kilo / Vibe mcp-json.
- Cleaner install summary: “N catalogued · M auto-plugin · K on this machine”.

## [0.5.30] — 2026-09-30

- **Plugin polish**: `supercompress doctor` — clean per-harness health matrix (account / MCP / hooks / instructions).
- **Setup UX**: quieter output, shared install summary table, `setup --yes` skips reconnect prompt.
- **MCP launch**: prefer `supercompress-mcp` shim in agent configs when on PATH (one-arg, upgrade-safe).
- Unified Agent Plugin skill copy (local + hosted/cloud). Docs: `doctor` in coding-agents quickstart.

## [0.5.29] — 2026-09-28

- **Grok Build**: PostToolUse now replaces the model's tool result via `updatedToolOutput` (Grok discards `UserPromptSubmit` `additionalContext`). Keeps Bash/`toolResult` shape; truncated payloads get a short note only. Inbox + MCP remain fallbacks. Replace helpers live in `grok-post-tool.js` and are copied into `~/.cursor/hooks/supercompress/` on install.

## [0.5.28] — 2026-08-18

- **Grok Build video-ready**: session digests also mirror to `~/.supercompress/inbox/latest.md` (what AGENTS.md points at). Earlier attempt used `UserPromptSubmit` inject; see 0.5.29 for the PostToolUse replace path. Stronger `~/.grok/AGENTS.md` + skill playbook.
- **postinstall is guidance-only** — never mutates MCP/agent configs; run `supercompress setup` or `plugin`
- `prepack` / `npm run sync:assets` copies compress-engine + model from canonical `web/assets/`

## [0.5.27] — 2026-08-18

- **fx (Vercel Labs)**: auto-install trusted MCP at `~/.fx/mcp.json`, always-on `~/.fx/AGENTS.md`, and `~/.fx/skills/supercompress` (lazy MCP tool discovery instructions).
- **Any agent**: `supercompress agents connect` prints a one-shot MCP recipe and writes an [Agent Plugins 1.0](https://agent-plugins.org/) pack (`agent-plugin/` — plugin.json + mcp.json + skill).
- Ship portable `agent-plugin/` with the npm package for open/closed-source hosts and DIY agents.

## [0.5.26] — 2026-08-18

- **Grok Build actually works**: write always-on rules to `~/.grok/AGENTS.md` (Grok never reads `~/.grok/rules/`), plus a user skill. MCP uses Grok's inline `env = { … }` table, an absolute `node` path, and `[mcp] max_output_bytes = 2000000` so compress digests are not truncated at 20KB. Hooks use `env{}` (not a `VAR=value` command prefix Grok may fail to spawn), 60s timeout, and parse Grok's camelCase `toolResult` payload. MCP usage is attributed as Grok Build.

## [0.5.25] — 2026-08-16

- **Grok Build (xAI) first-class**: auto-install MCP in `~/.grok/config.toml`, hooks in `~/.grok/hooks/supercompress.json`, and always-on rules in `~/.grok/rules/supercompress.md` via `setup` / `plugin`.
- Classic CLI remains the default; OpenTUI is opt-in (`supercompress tui` / `SUPERCOMPRESS_TUI=1`).
- `connect` / MCP `connect_account`: skip browser when already linked (`--force` to re-link).

## [0.5.24] — 2026-08-16

- **Classic CLI is the default again** — bare `supercompress` shows help; OpenTUI is opt-in via `supercompress tui` or `SUPERCOMPRESS_TUI=1`.
- **`connect` / MCP `connect_account`**: if already linked with a valid key, skip the browser loop (use `--force` to re-link).
- Dashboard: when already signed in, `?connect=` auto-links with retries and a clear success message.

## [0.5.23] — 2026-08-15

- **`plugin` persists `configured_agents`** so `account` / `status` show MCP installs on this machine.
- **`account` status**: no more false “not linked yet” when MCP/hooks are installed locally; API `me` treats API-key auth as linked.

## [0.5.22] — 2026-08-15

- **TUI theme**: follow terminal dark/light (macOS appearance / `COLORFGBG`; override with `SUPERCOMPRESS_THEME=dark|light`) — no more forced paper-light UI in dark terminals.
- **`supercompress account`**: call `/api/account?op=me` for API-key auth (plain `/api/me` is Firebase dashboard session only).

## [0.5.21] — 2026-08-14

- Idempotency keys are ≤40 chars (Auth claims watermarks truncate at 40; longer `sc_…` keys caused billing 503s for MCP/hooks).

## [0.5.20] — 2026-08-14

- **Accept Auth-backed API keys** (`sc_live_sck_…`): compressor `isValidApiKey` no longer rejects real linked keys (was treating `_` in the secret as invalid → “API key not found” / zero-looking usage until re-setup).
- Hosted compress retries on transient **503/429/timeout** with the same Idempotency-Key (billing-safe).
- Tests: unique MCP `session_id`s; concurrent MCP soft-retries on platform 503s.

## [0.5.19] — 2026-08-12

- **Interactive TUI** (`supercompress` / `supercompress tui`): paper-branded OpenTUI dashboard with live usage, account, connect, setup, plugin, agents, proxy, and MCP check. Needs [Bun](https://bun.sh); classic commands still work without it (`SUPERCOMPRESS_TUI=0` or `--plain`).
- Align CLI/MCP `usage` totals with the dashboard billing ledger (not coding-agent subset alone).
- Stable MCP launch after npm/brew upgrades: PATH `node` + package `mcp.js` (not Homebrew Cellar-pinned binaries); postinstall refreshes MCP paths without clearing auth.
- Docs: run `supercompress plugin` after upgrades to refresh integrations without reconnecting.
- Hook `Idempotency-Key` includes normalized **query** (avoids 409 when context reused for a new task).
- Partial chunk failure no longer marks session hashes seen; OpenClaw/Cursor feed full dumps into the chunker (1.2M soft cap, not 180k hard clip).
- OpenClaw skips inbox compress when no session/conversation id (no shared cwd fallback).
- **OpenClaw auto-compress parity with Hermes**: setup/plugin installs MCP + `AGENTS.md` + managed skill + internal hooks + extension plugin (tool dumps → inbox); uninstall cleans them.
- **Session-scoped inbox** (`inbox/<sessionId>/`) + `SUPERCOMPRESS_CONFIG_DIR` for OpenClaw plugin/hooks (no global `latest.md` cross-session leak).
- Exact OpenClaw plugin path match on install/uninstall (no substring deletes).
- `compactSessionMemory()` for OpenClaw compact:before; chunk dumps ≤120k; stable hook `Idempotency-Key`.
- **Preserve tool-call / tool-result order** when splitting compressible history (no reverse via `unshift`).
- Rank structured-history compression against the **latest user ask in the full thread**, not an older compressible-prefix turn.
- Send `Idempotency-Key` on compress API calls for safer retries with request-level billing idempotency.

## [0.5.18] — 2026-08-11

- **Keep auth across npm updates**: MCP entries use PATH `node` + this package's `mcp.js` (not Homebrew Cellar-pinned binaries). `postinstall` refreshes MCP paths when an account is already linked — never clears `~/.supercompress/config.json`.
- Docs: run `supercompress plugin` after upgrades to refresh integrations without reconnecting.

## [0.5.17] — 2026-08-10

- **Fix agent attribution**: Cursor postToolUse no longer mislabels usage as `claude_code` when the payload has `session_id`/`cwd` (Cursor always does).
- Cursor hooks now set `SUPERCOMPRESS_AGENT_NAME=Cursor` explicitly (same pattern as Claude Code / Codex).
- Stop using `configured_agents[0]` as the compress agent name (setup lists every detected agent).

## [0.5.16] — 2026-08-09

- **Hard paywall surfacing**: Cursor/Claude hooks + MCP no longer silently fail-open on HTTP 402.
- Inject loud `[SuperCompress PAYWALL]` upgrade CTA into agent context; proxy returns 402 (not 502) with billing URL.
- Restore missing `compressIncremental` export used by MCP `compress_context`.

## [0.5.15] — 2026-08-09

- **Setup-first**: `supercompress setup` / `plugin` is the recommended path (auto MCP + hooks). `wrap` deprecated.
- **Zed**: detect macOS Zed app; write MCP via `context_servers` (not Cursor `mcpServers`).
- Docs/links prefer `https://docs.supercompress.dev/...`.

## 0.5.14 — 2026-08-08

- **README rewrite**: wrap-first install (`supercompress wrap claude|codex|aider`). Removed monorepo / local-path install warnings. MCP documented as optional. Benchmarks linked.

## 0.5.13 — 2026-08-08

- Same README rewrite (initial publish).

## 0.5.12

- Harden device-link pairing codes to 128-bit entropy.

## 0.5.11 — 2026-08-07

- **CLI `account` / `usage`**: show linked account, plan/quota, and per-agent token savings (`supercompress usage [--json]`).
- Louder **paywall** handling in the proxy compressor (402 / free quota / credits exhausted) with correct **$0.10 / 1M** copy.
- Hooks/MCP compress requests pass `source` + `session_id` for better activity attribution; clearer timeout vs error skip reasons.

## 0.5.10 — 2026-08-05

- **Fix device connect hang**: reconnect no longer fails silently when the account is at the API-key plan limit. `connect-device` rotates prior Coding agent / CLI keys and mints a fresh one.
- Dashboard shows linking / connected / retry banner; keeps `?connect=` on failure so Retry works.
- CLI `setup` / `connect`: www URL, longer wait, progress ticks, paste-key fallback after timeout.

## 0.5.9 — 2026-08-05

- **Fast global install**: drop `@modelcontextprotocol/sdk` + `node-fetch` (was ~100 transitive packages / ~27MB). MCP is a tiny zero-dep stdio JSON-RPC server; uses Node 18+ `fetch`. Fixes `npm install -g supercompress-proxy` hangs/timeouts on slow registries.
- **Hermes auto-compress**: shell hooks (`pre_llm_call` / `post_tool_call`), `transform_tool_result` plugin, native `compression` + `proactive_prune_tokens`, absolute MCP launch path, idempotent `AGENTS.md`.
- **Hermes + OpenClaw MCP**: auto-wire `~/.hermes/config.yaml` (`mcp_servers`) and `~/.openclaw/openclaw.json` (`mcp.servers`); also `~/.mcporter/mcporter.json` when present.
- **Pluggable custom agents**: `supercompress agents add|rm` + `~/.supercompress/agent-plugins.json` / `plugins/*.json` (formats: mcp-json, hermes-yaml, openclaw-json, opencode-json, codex-toml, instruction-only).
- `supercompress mcp-check` verifies the MCP server lists `compress_context` / `connect_account` / `usage_summary`.
- Incremental session memory in hooks + MCP (`compress_context`): compress only new chunks; compact when memory grows large.
- Prefer `tokens_saved_pct` for prompt-token savings while accepting the deprecated `kv_savings_pct` response alias.
- Correct the package README license statement: SuperCompress is MIT licensed and permits commercial use.

## 0.5.8 — 2026-08-02

- **Headroom-parity every-submit compress**: Cursor `beforeSubmitPrompt` + Claude/Codex `UserPromptSubmit` compress context on every message that has real context; tiny asks (~&lt;400 chars / ~100 words) skip — same floor as the proxy.
- User ask stays the query (never mangled); pasted/attached/tool context is compressed into `~/.supercompress/inbox/latest.md` + `additional_context`.
- Tool-dump hook threshold lowered from 800 → 400 chars to match.

## 0.5.7 — 2026-08-01

- Auto MCP install across detected agents (Cursor, Claude, Codex, OpenCode, FreeBuff, Windsurf, Continue, Gemini, Goose, Crush, Amp, Zed, Copilot, Roo, Cline, …).
- Claude Code + Codex: `UserPromptSubmit` + `PostToolUse` hooks for every-message and tool-dump compression.
- Always-on instruction files (CLAUDE.md / AGENTS.md / …) when those agents are present.
- New `supercompress wrap <agent>` — Headroom-style proxy wrap for full-traffic auto-compress.

## 0.5.6 — 2026-07-31

- Every-message compress threshold lowered (compress prompts ≥40 chars; tiny ones still write inbox).

## 0.5.5 — 2026-07-31

- **Every-message auto-compress**: IDE `beforeSubmitPrompt` writes `~/.supercompress/inbox/latest.md` on every submit; Claude Code + Codex `UserPromptSubmit` inject compressed digests; `postToolUse` threshold lowered to 800 chars.
- Always-on agent rule forces Read of inbox digest first every turn.

## 0.5.4 — 2026-07-28

- OpenCode MCP: write `enabled: true`, `timeout: 60000`, and `experimental.mcp_timeout` (OpenCode’s default tool-fetch timeout is 5s). Prefer `supercompress-mcp` on PATH over a baked absolute Node path.

## 0.5.3 — 2026-07-28

- Harden MCP stdio server against `-32000: Connection closed`: catch unhandled errors, keep process alive on tool failures, timeouts on API calls, stderr-only logging, drop unused elicitation capability.

## 0.5.2 — 2026-07-26

- Ship LICENSE + CHANGELOG in the npm tarball.

## 0.5.1 — 2026-07-26

- **postinstall is guidance-only** — no longer rewrites agent MCP configs on `npm install`. Use `supercompress setup` or `supercompress plugin`.
- **FreeBuff dual-launch** — MCP compress handshake waits for tool responses (no early timeout flake).
- Docs/README aligned with MCP-first install path; agent catalog count 49.

## 0.5.0 — 2026-07-26

- MCP-first coding-agent plugin (`compress_context`, `connect_account`, `usage_summary`).
- Optional localhost API proxy via `supercompress setup --proxy`.
- Hard launch of SuperCompress coding agent integrations (Cursor, Claude Code, Codex, and more).
