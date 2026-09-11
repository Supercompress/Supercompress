#!/usr/bin/env bash
# Local mirror of .github/workflows/ci.yml — use when Actions minutes are exhausted.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

echo "==> Python package smoke"
python3 - <<'PY'
from supercompress import CompressResult, compress_for_turn
from supercompress.client import CompressResult as CR2
assert CompressResult is CR2
r = compress_for_turn("a\nb\nc\nd", "what is b?", budget_ratio=0.5)
assert isinstance(r, CompressResult)
assert r.compressed_text
assert "what is b?" not in r.compressed_text
try:
    compress_for_turn("x", "q", budget_ratio=0)
    raise SystemExit("expected ValueError")
except ValueError:
    pass
try:
    compress_for_turn("x", "q", mode="precision")
    raise SystemExit("expected RuntimeError without key")
except RuntimeError:
    pass
print("ok", r.policy_name, r.tokens_saved_pct)
PY

python3 examples/integrations/openai_wrapper.py >/dev/null
python3 examples/integrations/langchain_hook.py >/dev/null
python3 examples/demo_compare.py >/dev/null

echo "==> JS syntax smoke"
node --check api/demo/compress.js
node --check api/_lib/store.js
node --check api/_lib/engine.js
node --check api/_lib/billing-ledger.js
node --check packages/proxy/src/compressor.js
node --check packages/proxy/src/forwarder.js
node --check packages/proxy/src/server.js

echo "==> Unit tests"
node api/_lib/billing-ledger.test.js
node api/_lib/credit-amount.test.js
node api/_lib/coding-agent-usage.test.js
node api/_lib/http-soft-probe.test.js
node api/_lib/firebase-off.test.js
node api/_lib/power-user.test.js
node --test api/_lib/onboarding.test.js
node api/_lib/retention.test.js
node api/_lib/payment-thank-you.test.js
node api/_lib/auth-connect.test.js
node api/_lib/founder-usage.test.js
node api/_lib/usage-days.test.js
node api/stats.test.js
node web/assets/js/analytics-data.test.js

echo "==> Proxy package tests"
(
  cd packages/proxy
  node test/smoke.js
  node test/agent-plugins.js
  node test/uninstall-clean.js
  if [ -f test/protocol-safety.js ]; then node test/protocol-safety.js; fi
)

echo "==> Guards"
node scripts/check-no-pii.js
node scripts/check-versions.js
npm run check:stylesheet-paths
node scripts/check-api-host-routes.test.js
node scripts/check-api-host-routes.js
node scripts/sync-compress-assets.js --check

echo "CI local: all checks passed"
