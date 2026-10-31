#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--check" && "$1" != "--dry-run" ) ]]; then
  echo "Usage: npm run deploy:api [-- --check|--dry-run]. Deployment overrides are disabled for the unreleased control plane." >&2
  exit 1
fi

node scripts/check-api-host-routes.js
node scripts/check-control-plane-release.js
npm run test:api
if [[ "${1:-}" == "--check" || "${1:-}" == "--dry-run" ]]; then
  echo "API preflight passed (no authentication or deployment)."
  exit 0
fi

FLY="${FLYCTL_BIN:-$(command -v flyctl || command -v fly || true)}"
if [[ -z "$FLY" ]]; then
  echo "Missing Fly CLI: install flyctl before deploying." >&2
  exit 1
fi
if ! "$FLY" auth whoami >/dev/null; then
  echo "Fly authentication required: run flyctl auth login, then npm run deploy:api." >&2
  exit 1
fi
"$FLY" secrets list --app supercompress-api --json | node scripts/check-control-plane-release.js --fly-secrets
"$FLY" config validate --config fly.api.toml
"$FLY" deploy --config fly.api.toml --remote-only --ha=false
SUPERCOMPRESS_API_HOST="${SUPERCOMPRESS_API_HOST:-https://supercompress-api.fly.dev}" node scripts/fly-api-smoke.js
