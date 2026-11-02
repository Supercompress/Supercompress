# Control Plane gateway runbook

The gateway (OpenAI-compatible `POST /v1/chat/completions` and `GET /v1/models`) runs as its
own Fly app, `supercompress-gateway`, at `https://gateway.supercompress.dev`. It uses the same
image as `supercompress-api`, with `SC_API_SURFACE=gateway`, so it serves only gateway routes.
`supercompress-api` keeps every `SC_CP_*` flag off (`node scripts/check-control-plane-release.js`).

## How a request is paid for

Model spend comes out of the account's prepaid SuperCompress credit balance, the same balance
`/v1/compress` burns (`api/_lib/cp-billing.js`):

1. Admission prices the worst case (requested model, every message, `max_tokens` or 4096
   output tokens) and places a hold on the balance. No credit means 402 `credits_required`;
   free accounts cannot spend on models.
2. Each account has a daily gateway spend cap: `SC_CP_DAILY_CAP_USD` (default $25), or the
   per-account `sc_cp_daily_cap_usd` claim. Today's spend is the `sc_cp_day` claim.
3. After the response, the actual cost (catalog price × reported usage, long-context rates
   above the threshold) is charged, never more than the remaining balance. Failures before
   the provider answers release the hold and charge nothing.

Holds and the idempotency replay cache are in-process: run **one machine**. Scaling out needs
a shared hold store first.

## Environment

Config (`fly.gateway.toml`, checked by `node scripts/check-control-plane-release.js --gateway`):

| Name | Value | Notes |
| --- | --- | --- |
| `SC_API_SURFACE` | `gateway` | required; serves only gateway routes |
| `NODE_ENV` | `production` | required |
| `SUPERCOMPRESS_USE_FIRESTORE` | `0` | required; billing runs on Auth claims. Must not be a secret |
| `SC_CP_GATEWAY` | `1` | required |
| `SC_CP_LEDGER`, `SC_CP_TRACE`, `SC_CP_ROUTE` | `1` | approved; each needs `SC_CP_GATEWAY` |
| `SC_CP_RESERVE`, `SC_CP_ENTERPRISE`, `SC_CP_OPS` | `0` | not approved for launch |
| `SC_CP_DAILY_CAP_USD` | `25` | default per-account daily cap |
| `SC_CP_NK_BUDGET_MS` | `1500` | Neural Keep budget inside a request; then the local compiler |
| `SC_CP_UPSTREAM_TIMEOUT_MS` | `300000` | whole-response timeout per provider call |
| `SC_CP_POLICY` / `SC_CP_POLICY_FILE` | optional | gateway-wide policy (allowlist, strategy, fallbacks, ceilings) |
| `SC_CP_CATALOG` / `SC_CP_CATALOG_FILE` | optional | extra or overriding catalog models |

Forbidden in production (guard fails): `SC_CP_ALLOW_STUB`, `SC_AUTH_DEV`, `SC_CP_WALLET_SEED`,
and any `SC_CP_*` flag set as a Fly secret.

Secrets (`flyctl secrets import -a supercompress-gateway`; names only, never paste values in a PR):

- Firebase Admin: `FIREBASE_SERVICE_ACCOUNT_JSON` (or `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`,
  `FIREBASE_PRIVATE_KEY`): same project as `supercompress-api`.
- Neural Keep: `SC_NEURAL_KEEP`, `SC_NEURAL_KEEP_URL`, `SC_NEURAL_KEEP_SECRET`.
- Provider keys, one per provider you launch with: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `GROQ_API_KEY`,
  `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, `PERPLEXITY_API_KEY`, `OPENROUTER_API_KEY`,
  `CEREBRAS_API_KEY`, `COHERE_API_KEY`, `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT`,
  `OLLAMA_BASE_URL`. A provider's models are routable only when its key is set; with none
  set, every call fails (there is no stub in production).

## Launch

1. Merge the launch PR; CI runs `npm run test:cp` and `npm run test:api`.
2. From a clean worktree of `github/main`: `bash scripts/deploy-gateway.sh --check`.
3. `flyctl apps create supercompress-gateway --org <org>`; allocate IPs
   (`flyctl ips allocate-v4 -a supercompress-gateway`, `flyctl ips allocate-v6 …`).
4. Import the secrets above.
5. `bash scripts/deploy-gateway.sh` (guard, tests, clean-main check, deploy, smoke).
6. DNS (Vercel DNS): A/AAAA `gateway.supercompress.dev` → the gateway IPs;
   `flyctl certs add gateway.supercompress.dev -a supercompress-gateway`.
7. Live smoke with a funded test account:
   `SC_GATEWAY_HOST=https://gateway.supercompress.dev SC_GATEWAY_SMOKE_KEY=sc_… node scripts/gateway-smoke.js`
8. Only then publish the docs and landing that point at `gateway.supercompress.dev/v1`, and flip
   the "control plane is not launched" sentences (`web/llms-full.txt`, `web/ai-search.json`,
   dashboard `content.json`).

## Watching it

Every request logs one JSON line, `{"evt":"cp_chat", request_id, org, key_id, model_requested,
model_routed, provider, status, usd, tokens_saved, ms, err}`; no prompts, completions or keys.
`flyctl logs -a supercompress-gateway | grep cp_chat`. Settle failures log
`[cp] settle failed <request_id>`: the response was served but the charge did not land;
reconcile by hand from the log line's `usd`.

## Rollback

- Bad gateway release: `flyctl releases -a supercompress-gateway`, then
  `flyctl deploy -a supercompress-gateway --image <previous image>`. Holds in flight are lost
  with the old process (nothing was charged for them); settled charges are already on claims.
- Turn the gateway off: set `SC_CP_GATEWAY = "0"` in `fly.gateway.toml` and deploy, or
  `flyctl scale count 0 -a supercompress-gateway`. Every gateway path then returns 404.
  `supercompress-api` (compress, billing, MCP) is unaffected either way.
- Do not set `SC_CP_*` as Fly secrets to flip flags: the guard rejects it on the next deploy.
