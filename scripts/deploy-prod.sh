#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--check" || "${1:-}" == "--dry-run" ]]; then
  echo "Running release checks only (no deployment)."
  npm ci --omit=optional --ignore-scripts --no-audit --no-fund
  npm run release:check
  exit 0
fi

bash scripts/require-clean-main.sh

if ! command -v vercel >/dev/null 2>&1; then
  echo "Missing Vercel CLI. Install it with: npm install --global vercel" >&2
  exit 1
fi

npm ci --omit=optional --ignore-scripts --no-audit --no-fund
npm run release:check
node scripts/check-api-host-routes.js
vercel deploy --prod --yes

# Critical: www/docs/apex must stay aliased or they return DEPLOYMENT_NOT_FOUND
# under wildcard DNS. api.supercompress.dev is served by Fly (explicit DNS).
bash scripts/ensure-prod-domains.sh
bash scripts/prod-smoke.sh
