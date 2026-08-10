# API Dashboard

Sign up, create API keys, and call the hosted compress endpoint with usage tracking.

**Live:** [supercompress.dev/dashboard](https://www.supercompress.dev/dashboard)

## Production

The product API and dashboard ship on **Vercel** from this repository:

- Serverless routes under `api/` (`/api/health`, `/api/keys`, `/api/v1/compress`, billing, connect-device, …)
- Dashboard static UI under `web/`
- Keys / usage / billing: Firebase Auth + Firestore (with durable `key_usage` / `billing` collections)

There is no separate FastAPI / `local_web_server.py` runtime in this tree.

### Firebase

1. Create a [Firebase project](https://console.firebase.google.com/)
2. Enable **Authentication** → Email/Password and Google
3. Create a **Firestore** database
4. Configure the Vercel project with Firebase Admin credentials + web config
5. Add **supercompress.dev** / **www.supercompress.dev** to Authorized domains

Deploy Firestore rules:

```bash
firebase deploy --only firestore:rules
```

Local static preview of the site can use any static server against `web/`; authenticated API calls still need a deployed (or emulated) Vercel/`api` backend.

## Dashboard

| URL | Description |
|-----|-------------|
| `/dashboard` | Sign up / sign in, manage keys, view usage |
| Docs | [docs/API.md](./API.md) |

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

Prefer **POST** with header auth (query-string keys/context are deprecated):

```http
POST /api/v1/compress
X-API-Key: sc_live_xxxxxxxx
Content-Type: application/json

{
  "context": "long document…",
  "query": "Summarize this context.",
  "budget_ratio": 0.35
}
```

Or: `Authorization: Bearer sc_live_…`

Response includes `compressed_text`, token counts, and savings metrics. Usage is recorded automatically.

### Playground (no key)

`POST /api/demo/compress` remains unauthenticated for the browser demo.

## Security

- Long-lived API key secrets are stored as hashes (plus short-lived device-link secrets in Auth/Firestore during connect)
- Firestore is server-side only; the dashboard uses Firebase Auth client SDK + same-origin API calls
- Revoked keys stop authenticating immediately
