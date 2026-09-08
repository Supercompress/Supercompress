## Contributor notes

| Ban | Meaning |
|-----|---------|
| **No api-host catch-all redirects** | Never add `/:path*`, `/(.*)`, or any regex redirect on `api.supercompress.dev`. Explicit marketing paths only. After `vercel.json` edits run `node scripts/check-api-host-routes.js`. |

## Local development

- Install: `npm ci` and `pip install -e ".[test]"` as needed
- JS tests: `npm test` (or the scripts listed in `package.json`)
- Python tests: `pytest -q`
- Proxy package lives in `packages/proxy`

## Architecture boundaries

- Public tree = released product, docs, tests, and reproducible benchmarks
- Do not commit secrets, `.env*`, outreach dumps, model weights, or unreleased launch assets
- Prefer small PRs with clear test plans

## Security

- Auth project identity must come from trusted env / service-account config only
- Never enable `SC_AUTH_DEV` in production
- See `SECURITY.md` for reporting
