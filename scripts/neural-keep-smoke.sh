#!/usr/bin/env bash
# Smoke the Neural Keep HTTP service (local or Fly).
set -euo pipefail

BASE="${1:-http://127.0.0.1:8789}"
BASE="${BASE%/}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

echo "==> health $BASE/health"
curl -fsS "$BASE/health" | python3 -m json.tool

python3 - <<'PY' >"$TMP"
import json
ctx = "INCIDENT: warehouse W-ORBIT shelf S-19 tipped at 03:14Z\n"
ctx += "SKU pallet PLT-NEON-88 contains lithium cells LOT-QX441\n"
ctx += "Action: lock aisle 19, page safety lead Amira Okonkwo\n"
ctx += "\n".join(f"rfid_ping bay={i} ok" for i in range(21))
print(json.dumps({"context": ctx, "query": "What happened in warehouse W-ORBIT?"}))
PY

echo "==> compress"
AUTH=()
if [[ -n "${SC_NEURAL_KEEP_SECRET:-}" ]]; then
  AUTH=(-H "Authorization: Bearer $SC_NEURAL_KEEP_SECRET")
fi
curl -fsS -X POST "$BASE/v1/compress" \
  -H 'Content-Type: application/json' \
  "${AUTH[@]}" \
  -d @"$TMP" | python3 -m json.tool

echo "OK neural-keep smoke"
