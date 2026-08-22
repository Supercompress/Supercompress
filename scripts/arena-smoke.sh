#!/usr/bin/env bash
# Arena page + API smoke (static assets + compare handler).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

pass=0
fail=0

ok() { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }

echo "==> syntax"
node --check web/assets/js/arena.js && ok "arena.js syntax"
node --check api/arena/compare.js && ok "compare.js syntax"

echo "==> static arena page"
for needle in "Compression Arena" "arena-proof-grid" "arena-insights" "Run arena" "Break board"; do
  if grep -q "$needle" web/arena.html; then ok "arena.html contains: $needle"
  else bad "arena.html missing: $needle"; fi
done

echo "==> API handler"
node api/arena/compare.test.js && ok "compare.test.js"

echo "==> CSS version bump"
if grep -q 'arena.css?v=2' web/arena.html; then ok "arena.css v2 linked"
else bad "arena.css version"; fi

echo ""
echo "Arena smoke: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
