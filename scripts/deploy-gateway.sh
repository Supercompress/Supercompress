#!/usr/bin/env bash
# Deploy the Control Plane gateway (supercompress-gateway, gateway.supercompress.dev).
#   bash scripts/deploy-gateway.sh --check   preflight only (no Fly calls)
#   bash scripts/deploy-gateway.sh           guard + tests + clean-main check + deploy + smoke
# Runbook: docs/CP_RUNBOOK.md
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--check" && "$1" != "--dry-run" ) ]]; then
  echo "Usage: bash scripts/deploy-gateway.sh [--check|--dry-run]" >&2
  exit 1
fi

node scripts/check-control-plane-release.js --gateway
node scripts/check-control-plane-release.js
npm run test:cp
if [[ "${1:-}" == "--check" || "${1:-}" == "--dry-run" ]]; then
  echo "Gateway preflight passed (no authentication or deployment)."
  exit 0
fi

bash scripts/require-clean-main.sh

FLY="${FLYCTL_BIN:-$(command -v flyctl || command -v fly || true)}"
if [[ -z "$FLY" ]]; then
  echo "Missing Fly CLI: install flyctl before deploying." >&2
  exit 1
fi
"$FLY" auth whoami >/dev/null
"$FLY" secrets list --app supercompress-gateway --json | node scripts/check-control-plane-release.js --fly-secrets --gateway
"$FLY" config validate --config fly.gateway.toml
"$FLY" deploy --config fly.gateway.toml --remote-only --ha=false
SC_GATEWAY_HOST="${SC_GATEWAY_HOST:-https://supercompress-gateway.fly.dev}" node scripts/gateway-smoke.js
