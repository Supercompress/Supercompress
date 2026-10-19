#!/usr/bin/env bash
# Ping IndexNow (Bing, Yandex, Seznam, Naver share it) with changed URLs.
# Run ONLY after a production deploy is live. Key file: web/1ade97a6bb5c418e8250421d93f175fc.txt
# Usage: bash scripts/indexnow-ping.sh https://www.supercompress.dev/faq [more URLs...]
#        bash scripts/indexnow-ping.sh --sitemap   (submit every www URL in web/sitemap.xml)
set -euo pipefail
cd "$(dirname "$0")/.."
KEY="1ade97a6bb5c418e8250421d93f175fc"
HOST="www.supercompress.dev"
if [[ "${1:-}" == "--sitemap" ]]; then
  mapfile -t URLS < <(grep -o "<loc>https://${HOST}[^<]*" web/sitemap.xml | sed 's/<loc>//')
else
  URLS=("$@")
fi
[[ ${#URLS[@]} -gt 0 ]] || { echo "No URLs given" >&2; exit 1; }
LIVE=$(curl -fsS "https://${HOST}/${KEY}.txt" || true)
[[ "$LIVE" == "$KEY" ]] || { echo "Key file not live at https://${HOST}/${KEY}.txt; deploy first." >&2; exit 1; }
JSON=$(printf '%s\n' "${URLS[@]}" | python3 -c 'import sys,json;print(json.dumps({"host":"'"$HOST"'","key":"'"$KEY"'","keyLocation":"https://'"$HOST"'/'"$KEY"'.txt","urlList":[l.strip() for l in sys.stdin if l.strip()]}))')
curl -sS -o /dev/null -w "IndexNow HTTP %{http_code}\n" -X POST "https://api.indexnow.org/indexnow" -H "Content-Type: application/json; charset=utf-8" -d "$JSON"
