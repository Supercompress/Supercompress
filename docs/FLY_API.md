# Hosted API on Fly

| Surface | Host |
|---------|------|
| Marketing site (`www`, docs, apex) | Vercel (static) |
| Compress / billing / MCP / account API | Fly app **`supercompress-api`** |
| Neural Keep inference | Fly app **`sc-neural-keep`** |

`api.supercompress.dev` DNS → Fly (use `flyctl ips list -a supercompress-api` to inspect assigned addresses).  
`www.supercompress.dev/api/*` and `/compress` rewrite to `https://supercompress-api.fly.dev` (edge proxy only — no Vercel Fluid functions).

## Deploy API

Run the local preflight without Fly credentials or a Docker daemon:

```bash
npm run deploy:api -- --check
```

This checks API routing and adapter behavior without contacting Fly or deploying.
It is not a container-build or production-readiness certification.

```bash
flyctl auth login # once on this computer, or supply FLY_ACCESS_TOKEN in CI
npm run deploy:api
```

Control plane remains unreleased. The Fly config explicitly disables its seven
feature flags; both deploy scripts reject enabled local flags. API deployment
also checks the remote secret names and refuses any control-plane flag secret,
because secrets can override config values. Clear those flag secrets before a
normal product deployment. Arbitrary Fly argument overrides are not accepted by
this wrapper. The post-deploy smoke requires gateway and ops endpoints to stay
404. A future control-plane launch needs a deliberate reviewed change to these
guards, not just an environment toggle.

`fly.api.toml` at the repository root is the only API deployment config. The deploy command checks authentication, routing, adapter tests, and config before deploying; then it smokes the Fly origin. It uses `--ha=false` to avoid creating a spare Machine automatically, not to resize or remove existing Machines. Review `flyctl machine list -a supercompress-api` separately before changing capacity. The paid Fly account does not establish which Machines, credits, or usage are covered; check billing rather than assuming a fixed monthly runtime cost.

The service-level `/health` check gates traffic. Shutdown allows 170 seconds to drain in-flight work, with a 180-second Fly kill timeout, covering the default 150-second neural request timeout. Review both values if increasing inference timeouts. Ordinary request bodies remain capped at 200 KB; MCP keeps its handler's 1.5 MB cap, and Stripe webhooks retain their raw request stream.

Secrets are not copied automatically. Preserve the existing Fly app and its secrets. For an initial migration, securely import the existing production Firebase Admin/client config, Stripe keys and webhook secret, OAuth signing/persistence settings, and any inference/provider keys with `flyctl secrets import -a supercompress-api`. Retain the public Firebase client config on Vercel as well: the website build still generates browser config. Do not commit or print secret values. Keep `SC_AUTH_DEV` disabled. Keep the trusted Firebase project identity unchanged. Do not create replacement Stripe customers, prices, subscriptions, or billing records to move hosts.

The current default uses Firebase Auth claims (`SUPERCOMPRESS_USE_FIRESTORE=0`), not Firestore. Do not remove legacy Gist, ledger, or test-store code until record migration and rollback are verified. Multiple Machines require review of durable rate limiting and any process-local state; a health check alone does not verify authenticated compression, billing durability, or OAuth persistence.

Verify the custom hostname and website proxy after deployment:

```bash
npm run api:smoke
SC_API_SMOKE_SKIP_ROOT=1 SUPERCOMPRESS_API_HOST=https://www.supercompress.dev npm run api:smoke
npm run prod:smoke
```

The API smoke verifies JSON health, Fly provenance (`X-SC-Host: fly`), authenticated-route rejection, OAuth discovery, and the unsigned webhook probe. It never charges a customer. Run a signed webhook event in Stripe test mode and authenticated compression separately before a billing migration. API `/` returns service JSON, and unknown marketing paths return 404; it does not serve the website.

Do **not** re-add `api.supercompress.dev` as a Vercel project domain.
`npm run deploy:prod` deploys only the website; it must not reclaim the API hostname.

## Local

```bash
npm run start:api
# In another shell:
SUPERCOMPRESS_API_HOST=http://127.0.0.1:8080 npm run api:smoke
npm run test:api
```

For an independent container check (Docker daemon required):

```bash
docker build -f services/api/Dockerfile -t supercompress-api .
docker run --rm -p 8080:8080 supercompress-api
```
