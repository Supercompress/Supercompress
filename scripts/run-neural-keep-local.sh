#!/usr/bin/env bash
# Run Neural Keep service locally against v4-large checkpoint.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVC="$ROOT/services/neural-keep"
export SC_NEURAL_DIR="$(cd "${SC_NEURAL_DIR:-$ROOT/checkpoints/sc-keep-crossencoder-v4-large}" 2>/dev/null && pwd || echo "$ROOT/checkpoints/sc-keep-crossencoder-v4-large")"
PORT="${NEURAL_KEEP_PORT:-8789}"

if [[ ! -f "$SC_NEURAL_DIR/config.json" ]]; then
  echo "Checkpoint not found at $SC_NEURAL_DIR" >&2
  exit 1
fi

cd "$SVC"
if ! python3 -c "import fastapi, uvicorn" 2>/dev/null; then
  echo "Installing neural-keep deps ..."
  python3 -m pip install -q -r requirements.txt
fi

export SC_NEURAL_DEVICE="${SC_NEURAL_DEVICE:-mps}"
export SC_NEURAL_LAZY_LOAD="${SC_NEURAL_LAZY_LOAD:-1}"
echo "Neural Keep on :$PORT  SC_NEURAL_DIR=$SC_NEURAL_DIR  device=$SC_NEURAL_DEVICE"
exec python3 -m uvicorn server:app --host 127.0.0.1 --port "$PORT"
