# API Dashboard

Sign up, create API keys, and call the hosted compress endpoint with usage tracking.

**Live:** [www.supercompress.dev/dashboard](https://www.supercompress.dev/dashboard)

## Quick start (local dev)

```bash
pip install -e ".[serve]"
SC_AUTH_DEV=1 SC_KEY_STORE=memory python scripts/local_web_server.py
```

Open [http://127.0.0.1:8790/dashboard](http://127.0.0.1:8790/dashboard). Dev mode accepts any email — no Firebase required.

## Production setup

### 1. Firebase project

1. Create a [Firebase project](https://console.firebase.google.com/)
2. Enable **Authentication** → Email/Password and Google
3. Create a **Firestore** database
4. Generate a **service account** JSON → set `GOOGLE_APPLICATION_CREDENTIALS`
5. Add **www.supercompress.dev** to Firebase Auth → Settings → Authorized domains
6. Copy web app config into env vars (see `scripts/generate-firebase-config.js`)

Deploy Firestore rules:

```bash
firebase deploy --only firestore:rules
```

### 2. Run the API server

```bash
pip install -e ".[serve,firebase]"
SC_KEY_STORE=firestore python scripts/local_web_server.py
```

For production, the live site ships serverless API routes on Vercel (`/api/health`, `/api/keys`, `/api/v1/compress`) with keys stored in Vercel Blob. No separate deploy step when using the main Vercel project.

**Optional self-host (Python FastAPI)**

```bash
fly apps create supercompress-api
fly volumes create sc_data --size 1 --region sjc -a supercompress-api
fly deploy
```

**Docker (local / other hosts)**

```bash
docker build -t supercompress-api .
docker run -p 8790:8790 -e SC_AUTH_DEV=1 -e SC_KEY_STORE=file -v sc-data:/data supercompress-api
```

**Render** — use the included `render.yaml` blueprint (Docker + persistent disk for keys).

Set `SC_API_BASE` in `firebase-config.js` only if the dashboard and API are on different origins. On the live Vercel site, leave it empty (`""`) so the dashboard hits the same origin.

## Dashboard

| URL | Description |
|-----|-------------|
| `/dashboard` | Sign up / sign in, manage keys, view usage |
| Docs link | [docs/API.md](./API.md) |

### Key management

- **Create** — name your key; full secret shown once (`sc_live_…`)
- **Rename** — update display name
- **Revoke** — permanently disable a key
- **Usage** — requests, tokens in/out, tokens saved per key

## API endpoints

### Authenticated (Firebase ID token)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/me` | Current user |
| GET | `/api/keys` | List keys + usage summary |
| POST | `/api/keys` | Create key `{ "name": "Production" }` |
| PATCH | `/api/keys/{id}` | Rename `{ "name": "New name" }` |
| DELETE | `/api/keys/{id}` | Revoke key |
| GET | `/api/keys/{id}/usage` | Usage for one key |

Header: `Authorization: Bearer <firebase_id_token>`

### Compress (API key)

```http
POST /api/v1/compress
X-API-Key: sc_live_xxxxxxxx
Content-Type: application/json

{
  "context": "long document…",
  "query": "Summarize this context."
}
```

Add `"mode": "fixed"` and `"budget_ratio": 0.35` only when you need explicit keep-ratio compression. Default is compiler (adaptive) — no budget field required.

Or: `Authorization: Bearer sc_live_…`

Response includes `compressed_text`, token counts, savings metrics, and `latency_ms`. Usage is recorded automatically.

**Rate limits:** 90 requests/minute per key; 600/hour per client IP. **Max context:** 120,000 characters.

### Playground (no key)

`POST /api/compress` remains unauthenticated for the browser demo and local testing.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SC_AUTH_DEV` | off | Accept `dev:uid:email` tokens |
| `SC_KEY_STORE` | `auto` | `memory`, `firestore`, or `auto` |
| `SC_KEY_STORE_FILE` | — | JSON file persistence (dev) |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | Firebase service account path |

## Billing & pricing (production)

Hosted compression billing uses Stripe on the live site (`https://www.supercompress.dev`).

| Tier | Price | Allowance | Behavior |
|------|-------|-----------|----------|
| Free | $0 | 1M tokens / month | Compression pauses when free allowance is used |
| Pay as you go | $0.30 / 1M tokens after free | Prepaid credit wallet | Top up from the dashboard (min $10 load); optional auto-recharge |

When free allowance is exhausted, the API returns HTTP `402` with `paywall: true`. Legacy metered subscriptions may still exist for older accounts — see `api/_lib/stripe.js` for operator env vars (`STRIPE_SECRET_KEY`, webhooks at `/api/billing/webhook`).

## Security

- Full API keys are never stored — only SHA-256 hashes
- Firestore is server-side only; clients use FastAPI + Firebase Auth
- Revoked keys are removed from the lookup index immediately
