#!/usr/bin/env bash
# Pre-launch gate: tests + leak audit (v2 must not be live on prod/GitHub main until T-0).
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

LIVE="${SUPERCOMPRESS_LIVE_URL:-https://www.supercompress.dev}"
API="${SUPERCOMPRESS_API_URL:-https://api.supercompress.dev}"
FAIL=0
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; FAIL=$((FAIL + 1)); }

echo "==> unit / integration"
npm run test:arena || fail test:arena
npm run test:neural-keep || fail test:neural-keep
node api/_lib/billing-ledger.test.js || fail billing-ledger
node api/_lib/compress-quality.test.js || fail compress-quality
node api/_lib/onboarding.test.js || fail onboarding
node api/arena/compare.test.js || fail arena-compare
node scripts/check-api-host-routes.js || fail api-host-routes

echo "==> production smoke (current prod — billing path)"
npm run prod:smoke || fail prod:smoke

echo "==> leak audit: v2 must NOT be public until deploy"
arena_status="$(curl -sSI --max-time 15 "$LIVE/arena" 2>/dev/null | head -1 || true)"
launch_status="$(curl -sSI --max-time 15 "$LIVE/engine-v2-launch" 2>/dev/null | head -1 || true)"
if echo "$arena_status" | grep -q '404'; then
  pass "prod /arena still 404 (v2 not deployed)"
else
  fail "prod /arena is live ($arena_status) — unexpected before T-0 deploy"
fi
if echo "$launch_status" | grep -q '404'; then
  pass "prod /engine-v2-launch still 404"
else
  fail "prod /engine-v2-launch is live ($launch_status) — unexpected before T-0"
fi
ARENA_API="$(curl -fsS --max-time 15 -X POST "$API/api/arena/compare" \
  -H 'Content-Type: application/json' \
  -d '{"context":"x","query":"y"}' 2>/dev/null || true)"
if echo "$ARENA_API" | grep -q '"probe":true'; then
  pass "prod arena API not wired (probe/404)"
elif echo "$ARENA_API" | grep -q '"ok"'; then
  fail "prod arena API returns compare JSON — v2 leaked to prod"
else
  pass "prod arena API not serving compare handler"
fi

echo "==> leak audit: GitHub main"
if git fetch github main --quiet 2>/dev/null; then
  if git ls-tree -r github/main --name-only 2>/dev/null | rg -q '^(web/arena\.html|api/arena/|web/engine-v2-launch)'; then
    fail "v2 files present on github/main"
  else
    pass "github/main has no arena / engine-v2-launch paths"
  fi
else
  echo "WARN: could not fetch github/main — skip remote leak check"
fi

echo "==> unpushed v2 commits (expected until T-0 push)"
UNPUSHED="$(git log github/feat/roadmap-community-rtk-seo..HEAD --oneline 2>/dev/null | wc -l | tr -d ' ')"
if [[ "${UNPUSHED:-0}" -gt 0 ]]; then
  pass "local branch ahead $UNPUSHED commits (arena/neural not on remote yet)"
  git log github/feat/roadmap-community-rtk-seo..HEAD --oneline 2>/dev/null | sed 's/^/       /'
else
  echo "WARN: no unpushed v2 commits — confirm branch state before launch"
fi

echo "==> outreach suppression"
python3 -c "
from scripts.outreach_suppression import is_suppressed
assert is_suppressed('Saurabh Parashar'), 'Saurabh block missing'
print('PASS Saurabh Parashar hard-blocked')
" || fail outreach-suppression

echo "==> launch assets (local)"
for f in web/arena.html web/engine-v2-launch.html api/arena/compare.js; do
  [[ -f "$f" ]] && pass "asset $f" || fail "missing $f"
done
rg -q 'engine-v2-launch' vercel.json && pass "vercel route /engine-v2-launch" || fail "vercel route missing"

echo "==> T-0 infrastructure gates"
CKPT="checkpoints/sc-keep-crossencoder-v4-large"
if [[ -f "$CKPT/model.safetensors" && -f /tmp/scneural-amazing-DONE ]]; then
  pass "v4-large checkpoint trained + gated"
elif [[ -f "$CKPT/model.safetensors" ]]; then
  fail "v4-large checkpoint exists but AMAZING gate not passed (training in progress?)"
else
  fail "v4-large checkpoint missing — bash scripts/scneural/run_amazing_v4_large.sh"
fi
if vercel env ls production 2>/dev/null | rg -q 'SC_NEURAL_KEEP_URL'; then
  pass "Vercel prod env SC_NEURAL_KEEP_URL staged"
else
  fail "Vercel prod env SC_NEURAL_KEEP_URL missing"
fi
if fly status -a "${FLY_NEURAL_APP:-sc-neural-keep}" >/dev/null 2>&1; then
  pass "Fly app sc-neural-keep exists"
else
  fail "Fly app missing — add billing (fly.io/dashboard/arjun-shah/billing) then scripts/launch/t0-go-live.sh"
fi

echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "=== Launch readiness: ALL PASSED ($LIVE) ==="
  echo "Next: merge + deploy at T-0, flip Stripe to 10¢/M, send emails (emails.md in gitignored launch-day folder)."
  exit 0
fi
echo "=== Launch readiness: $FAIL FAILED ==="
exit 1
