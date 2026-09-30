#!/usr/bin/env bash
# Copy local v4-large checkpoint onto Fly volume (one-time / after retrain).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${SC_NEURAL_DIR:-$ROOT/checkpoints/sc-keep-crossencoder-v4-large}"
APP="${FLY_NEURAL_APP:-sc-neural-keep}"

if ! command -v fly >/dev/null 2>&1; then
  echo "Install flyctl first" >&2
  exit 1
fi

for f in config.json model.safetensors tokenizer.json sc_meta.json; do
  if [[ ! -f "$SRC/$f" ]]; then
    echo "Missing $SRC/$f — set SC_NEURAL_DIR to a full HF checkpoint" >&2
    exit 1
  fi
done

echo "Syncing $SRC → $APP:/data/model (via fly ssh sftp)"
echo "This uploads ~1.5GB — may take several minutes."

# fly ssh sftp batch
fly ssh console -a "$APP" -C "mkdir -p /data/model" 2>/dev/null || true

while IFS= read -r rel; do
  echo "  → $rel"
  fly ssh sftp put -a "$APP" "$SRC/$rel" "/data/model/$rel"
done < <(cd "$SRC" && find . -type f \( -name '*.json' -o -name '*.safetensors' -o -name '*.txt' \) | sed 's|^\./||')

echo "Restarting machine to load weights ..."
fly machines restart -a "$APP" --force 2>/dev/null || fly deploy -a "$APP" --ha=false

echo "Smoke:"
bash "$ROOT/scripts/neural-keep-smoke.sh" "https://${APP}.fly.dev"
