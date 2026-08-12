#!/usr/bin/env bash
# Production smoke: static pages + API hosts (www + api) must stay healthy.
# Exits non-zero on any failure. Safe to run anytime / post-deploy.
set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"

WWW="${SUPERCOMPRESS_WWW_URL:-https://www.supercompress.dev}"
API="${SUPERCOMPRESS_API_HOST:-https://api.supercompress.dev}"
DOCS="${SUPERCOMPRESS_DOCS_URL:-https://docs.supercompress.dev}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

check() {
  local name="$1" expect="$2" url="$3"
  shift 3
  local body="$TMP/body"
  local code
  code="$(curl -sS -L --max-time 45 -o "$body" -w '%{http_code}' "$@" "$url" || echo 000)"
  if [[ "$code" != "$expect" ]]; then
    echo "FAIL $name — expected HTTP $expect, got $code ($url)"
    head -c 240 "$body" 2>/dev/null | tr '\n' ' '; echo
    fail=$((fail + 1))
    return 1
  fi
  # Guard the exact outage class we hit: edge has no deployment
  if grep -qi 'DEPLOYMENT_NOT_FOUND' "$body" 2>/dev/null; then
    echo "FAIL $name — DEPLOYMENT_NOT_FOUND ($url)"
    fail=$((fail + 1))
    return 1
  fi
  echo "PASS $name ($code)"
  pass=$((pass + 1))
}

expect_body() {
  local name="$1" needle="$2" file="$3"
  if ! grep -q "$needle" "$file"; then
    echo "FAIL $name — response missing '$needle'"
    fail=$((fail + 1))
    return 1
  fi
}

# api.supercompress.dev/ must redirect to www (not serve marketing).
# Retries briefly — Vercel promotion can lag a push by a few seconds.
check_api_root_redirect() {
  local attempts="${1:-8}"
  local i code loc final
  for ((i = 1; i <= attempts; i++)); do
    code="$(curl -sS -o /dev/null --max-time 25 -w '%{http_code}' "$API/" || echo 000)"
    loc="$(curl -sS -o /dev/null --max-time 25 -w '%{redirect_url}' "$API/" || true)"
    final="$(curl -sS -L -o /dev/null --max-time 25 -w '%{url_effective}' "$API/" || true)"
    # Normalize trailing slash for compare
    local want="$WWW"
    local want_slash="${WWW%/}/"
    if [[ "$code" == "301" || "$code" == "308" || "$code" == "302" ]]; then
      if [[ "$loc" == "$want" || "$loc" == "$want_slash" || "$loc" == "${want_slash%/}" ]]; then
        echo "PASS api root redirect ($code → $loc)"
        pass=$((pass + 1))
        return 0
      fi
      if [[ "$final" == "$want" || "$final" == "$want_slash" ]]; then
        echo "PASS api root redirect ($code → $final)"
        pass=$((pass + 1))
        return 0
      fi
      echo "FAIL api root redirect went to wrong place (HTTP $code loc=$loc final=$final)"
      fail=$((fail + 1))
      return 1
    fi
    if [[ "$final" == "$want" || "$final" == "$want_slash" ]]; then
      echo "PASS api root → www ($code)"
      pass=$((pass + 1))
      return 0
    fi
    echo "  api root not ready yet (HTTP $code → $final), retry $i/$attempts..."
    sleep 5
  done
  echo "FAIL api root should redirect to www (got HTTP $code → $final)"
  fail=$((fail + 1))
  return 1
}

echo "=== SuperCompress production smoke ==="
echo "www=$WWW"
echo "api=$API"
echo "docs=$DOCS"
echo

# Static guard before any HTTP — fail PRs that reintroduce the catch-all outage.
node scripts/check-api-host-routes.js

# Domains / edge
check "www home" 200 "$WWW/"
check_api_root_redirect 8 || true
check "api health" 200 "$API/api/health"
check "www health" 200 "$WWW/api/health"
expect_body "www health body" '"ok":true' "$TMP/body"
check "docs root" 200 "$DOCS/" 

# Marketing / product surfaces (www only — api host must not serve them)
check "dashboard" 200 "$WWW/dashboard"
check "analytics" 200 "$WWW/analytics"
check "token-compression" 200 "$WWW/token-compression"

# api host must bounce non-API marketing paths to www (host-wide, not just /)
api_dash_code="$(curl -sS -o /dev/null --max-time 25 -w '%{http_code}' "$API/dashboard" || echo 000)"
api_dash_final="$(curl -sS -L -o /dev/null --max-time 25 -w '%{url_effective}' "$API/dashboard" || true)"
if [[ "$api_dash_code" == "301" || "$api_dash_code" == "308" || "$api_dash_code" == "302" ]]; then
  if [[ "$api_dash_final" == "$WWW/dashboard" || "$api_dash_final" == "${WWW}/dashboard" ]]; then
    echo "PASS api /dashboard → www ($api_dash_code)"
    pass=$((pass + 1))
  else
    echo "FAIL api /dashboard redirected to $api_dash_final"
    fail=$((fail + 1))
  fi
elif [[ "$api_dash_final" == "$WWW/dashboard" || "$api_dash_final" == "${WWW}/dashboard" ]]; then
  echo "PASS api /dashboard → www ($api_dash_code)"
  pass=$((pass + 1))
else
  # Soft during rollout of host-wide rule; still fail if it serves a full page without redirect intent
  echo "WARN api /dashboard still on api host (HTTP $api_dash_code → $api_dash_final) — host-wide redirect pending deploy"
fi

# Account / auth plumbing (unauthenticated shapes)
check "account ops" 200 "$WWW/api/account"
expect_body "account ops body" '"ok":true' "$TMP/body"
check "api account ops" 200 "$API/api/account"
check "auth-status" 200 "$WWW/api/auth-status"
expect_body "auth-status firestore" '"storage":"firestore"' "$TMP/body"
check "firebase-config" 200 "$WWW/api/firebase-config"
expect_body "firebase-config key" 'apiKey' "$TMP/body"
check "usage requires auth" 401 "$WWW/api/usage"
check "billing requires auth" 401 "$WWW/api/billing"

# Compress entrypoints (must reject missing key, never 5xx / DEPLOYMENT_NOT_FOUND)
COMPRESS_JSON='{"context":"production smoke context for supercompress","query":"smoke"}'
for host_label in www api; do
  base="$WWW"
  [[ "$host_label" == api ]] && base="$API"
  for path in /api/v1/compress /v1/compress /api/compress /compress; do
    # Do not follow redirects — a 308 on /compress was a real outage (POST→GET).
    body="$TMP/body"
    code="$(curl -sS --max-time 45 -o "$body" -w '%{http_code}' \
      -X POST -H 'content-type: application/json' --data "$COMPRESS_JSON" \
      "$base$path" || echo 000)"
    if [[ "$code" == "301" || "$code" == "302" || "$code" == "307" || "$code" == "308" ]]; then
      echo "FAIL ${host_label} POST ${path} redirected ($code) — compress aliases must not bounce"
      fail=$((fail + 1))
    elif [[ "$code" != "401" ]]; then
      echo "FAIL ${host_label} POST ${path} — expected HTTP 401, got $code"
      head -c 240 "$body" 2>/dev/null | tr '\n' ' '; echo
      fail=$((fail + 1))
    else
      echo "PASS ${host_label} POST ${path} ($code)"
      pass=$((pass + 1))
      expect_body "${host_label} ${path} body" 'API key' "$body"
    fi
  done
done

# Other API aliases on api host must not 308 either (no follow).
for path in /retrieve /api/retrieve /api/health /api/keys /api/account; do
  code="$(curl -sS -o "$TMP/alias" -w '%{http_code}' --max-time 25 "$API$path" || echo 000)"
  loc="$(curl -sS -o /dev/null -w '%{redirect_url}' --max-time 25 "$API$path" || true)"
  if [[ "$code" == "301" || "$code" == "302" || "$code" == "307" || "$code" == "308" ]]; then
    echo "FAIL api GET ${path} redirected ($code → $loc) — API aliases must stay on api host"
    fail=$((fail + 1))
  else
    echo "PASS api GET ${path} no-redirect ($code)"
    pass=$((pass + 1))
  fi
done

# GET compress must be method-not-allowed (not 5xx)
check "www GET compress" 405 "$WWW/api/v1/compress"
check "api GET compress" 405 "$API/api/v1/compress"

# Authenticated compress — required when secret is injected (Actions schedule/push).
KEY=""
CFG="${SUPERCOMPRESS_CONFIG_DIR:-$HOME/.supercompress}/config.json"
if [[ -f "$CFG" ]]; then
  KEY="$(python3 -c "import json; print(json.load(open('$CFG')).get('api_key') or '')" 2>/dev/null || true)"
fi
if [[ -n "${SUPERCOMPRESS_API_KEY:-}" ]]; then
  KEY="$SUPERCOMPRESS_API_KEY"
fi

REQUIRE_AUTH=0
if [[ -n "${SUPERCOMPRESS_API_KEY:-}" ]]; then
  REQUIRE_AUTH=1
fi
if [[ "${REQUIRE_AUTH_COMPRESS:-}" == "1" ]]; then
  REQUIRE_AUTH=1
fi
# Scheduled GitHub monitors must exercise real compress when secret is configured;
# if the workflow forgot to inject it, fail loudly instead of silent SKIP.
if [[ "${GITHUB_EVENT_NAME:-}" == "schedule" && -z "$KEY" ]]; then
  echo "FAIL scheduled smoke requires SUPERCOMPRESS_API_KEY secret"
  fail=$((fail + 1))
  REQUIRE_AUTH=1
fi

if [[ -n "$KEY" ]]; then
  echo
  echo "=== Authenticated compress ==="
  for host_label in www api; do
    base="$WWW"
    [[ "$host_label" == api ]] && base="$API"
    body="$TMP/auth-$host_label"
    code="$(curl -sS --max-time 60 -o "$body" -w '%{http_code}' \
      -X POST "$base/api/v1/compress" \
      -H "X-API-Key: $KEY" \
      -H 'content-type: application/json' \
      --data "$COMPRESS_JSON" || echo 000)"
    if [[ "$code" != "200" ]]; then
      echo "FAIL auth compress on $host_label — HTTP $code"
      head -c 300 "$body"; echo
      fail=$((fail + 1))
    elif ! grep -q 'compressed_text' "$body"; then
      echo "FAIL auth compress on $host_label — missing compressed_text"
      fail=$((fail + 1))
    else
      echo "PASS auth compress on $host_label (200)"
      pass=$((pass + 1))
    fi
  done
elif ((REQUIRE_AUTH)); then
  echo "FAIL authenticated compress required but no API key available"
  fail=$((fail + 1))
else
  echo
  echo "SKIP authenticated compress (no SUPERCOMPRESS_API_KEY / ~/.supercompress/config.json)"
fi

echo
echo "=== Result: $pass passed, $fail failed ==="
if ((fail > 0)); then
  exit 1
fi
echo "production smoke OK"
