# Domains

## Canonical product host

- **Primary:** `https://www.supercompress.dev`
- **Apex:** `https://supercompress.dev` (308 → `www` on Vercel)

Use `www.supercompress.dev` in API clients and docs when redirects are not followed.

## `supercompress.com`

As of the 2026-08 audit, `supercompress.com` serves a **domain-parking / broker lander**, not the product. `/api/health` on `.com` returns Vercel `DEPLOYMENT_NOT_FOUND`.

**Required ops (outside this repo):**

1. Point `supercompress.com` DNS at the same Vercel project as `.dev`, **or**
2. Configure a permanent redirect: `https://supercompress.com/*` → `https://www.supercompress.dev/$1`

Until that lands, do not send ads, badges, or press links to `.com`.
