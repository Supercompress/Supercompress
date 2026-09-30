#!/usr/bin/env bash
# Deploy SuperCompress Neural Keep to Fly.io (no Vercel — model is too large for lambdas).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVC="$ROOT/services/neural-keep"
APP="${FLY_NEURAL_APP:-sc-neural-keep}"

if ! command -v fly >/dev/null 2>&1; then
  echo "Install flyctl: https://fly.io/docs/hands-on/install-flyctl/" >&2
  exit 1
fi

cd "$SVC"

if ! fly apps list 2>/dev/null | grep -q "^${APP}[[:space:]]"; then
  echo "Creating Fly app $APP ..."
  fly apps create "$APP" || true
fi

if ! fly volumes list -a "$APP" 2>/dev/null | grep -q neural_weights; then
  echo "Creating volume neural_weights (10GB) in sjc ..."
  fly volumes create neural_weights --region sjc --size 10 -a "$APP" -y
fi

echo "Deploying $APP ..."
fly deploy -a "$APP" --ha=false

echo ""
echo "Next: sync weights → fly volume"
echo "  bash scripts/sync-neural-weights-fly.sh"
echo ""
echo "Then set on Vercel API:"
echo "  SC_NEURAL_KEEP_URL=https://${APP}.fly.dev"
echo "  SC_NEURAL_KEEP_SECRET=<random>"
