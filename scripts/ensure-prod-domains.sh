#!/usr/bin/env bash
# Keep critical SuperCompress hostnames attached to the Vercel production
# deployment. Missing aliases cause edge DEPLOYMENT_NOT_FOUND under the
# wildcard DNS. api.supercompress.dev is NOT a Vercel host: its explicit
# A/AAAA records point at the Fly app supercompress-api, so it is only
# checked by the final edge gate, never re-attached here.
#
# Safety: never DELETE a healthy canonical domain (www). A repair script must
# not detach production to "re-promote" ordering.
set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"

PROJECT_JSON=".vercel/project.json"
if [[ ! -f "$PROJECT_JSON" ]]; then
  echo "Missing $PROJECT_JSON — run vercel link in this repo first." >&2
  exit 1
fi

# Prefer local CLI login on developer machines; VERCEL_TOKEN for CI.
if [[ -n "${VERCEL_AUTH_JSON:-}" && -f "${VERCEL_AUTH_JSON}" ]]; then
  AUTH_JSON="$VERCEL_AUTH_JSON"
elif [[ -f "$HOME/Library/Application Support/com.vercel.cli/auth.json" ]]; then
  AUTH_JSON="$HOME/Library/Application Support/com.vercel.cli/auth.json"
elif [[ -f "$HOME/.local/share/com.vercel.cli/auth.json" ]]; then
  AUTH_JSON="$HOME/.local/share/com.vercel.cli/auth.json"
else
  AUTH_JSON=""
fi
if [[ -n "$AUTH_JSON" ]]; then
  export VERCEL_TOKEN="$(python3 -c "import json; print(json.load(open(r'''$AUTH_JSON'''))['token'])")"
elif [[ -z "${VERCEL_TOKEN:-}" ]]; then
  echo "Missing Vercel auth — set VERCEL_TOKEN or run: vercel login" >&2
  exit 1
fi

export SUPERCOMPRESS_VERCEL_PROJECT_JSON="$PROJECT_JSON"
# Collect broken hosts (if any) for CLI repair.
BROKEN_FILE="$(mktemp)"
export BROKEN_FILE
python3 <<'PY'
import json, os, sys, urllib.error, urllib.request

REQUIRED = [
    "www.supercompress.dev",
    "docs.supercompress.dev",
    "supercompress.dev",
]
ALIAS_HOSTS = [
    "docs.supercompress.dev",
    "www.supercompress.dev",
]

proj = json.load(open(os.environ["SUPERCOMPRESS_VERCEL_PROJECT_JSON"]))
org_id = proj["orgId"]
project_id = proj["projectId"]
token = os.environ["VERCEL_TOKEN"]


def api(method, path, body=None):
    url = f"https://api.vercel.com{path}"
    sep = "&" if "?" in path else "?"
    if "teamId=" not in path:
        url = f"{url}{sep}teamId={org_id}"
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read().decode() or "{}"
            return resp.status, json.loads(raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {"raw": raw}
        return e.code, payload


print(f"Checking production domains for project {project_id}...")
code, domain_payload = api("GET", f"/v1/projects/{project_id}/domains")
if code != 200:
    print(f"FAIL listing domains HTTP {code}: {domain_payload}", file=sys.stderr)
    sys.exit(1)

names = {d.get("name") for d in domain_payload.get("domains", [])}
missing = [h for h in REQUIRED if h not in names]
if missing:
    print(f"Missing on project (will add via CLI): {' '.join(missing)}")
    open(os.environ["BROKEN_FILE"], "a").write("\n".join(f"missing:{h}" for h in missing) + "\n")
else:
    print("All required domains are attached to the project.")

# Ensure apex redirects to www without deleting www.
if "supercompress.dev" in names:
    code, _ = api(
        "PATCH",
        f"/v9/projects/{project_id}/domains/supercompress.dev",
        {"redirect": "www.supercompress.dev", "redirectStatusCode": 308},
    )
    print(f"Apex → www redirect ensure HTTP {code}")

code, deps = api(
    "GET",
    f"/v6/deployments?projectId={project_id}&target=production&limit=1&state=READY",
)
rows = (deps or {}).get("deployments") or []
if code != 200 or not rows:
    print(f"FAIL resolving production deployment HTTP {code}: {deps}", file=sys.stderr)
    sys.exit(1)
deployment = rows[0]
prod_url = "https://" + deployment["url"]
print(f"Production deployment: {prod_url}")
open(os.environ["BROKEN_FILE"], "a").write(f"prod_url:{prod_url}\n")

broken = []
for host in ALIAS_HOSTS:
    req = urllib.request.Request(f"https://{host}/", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            print(f"  edge {host} → HTTP {resp.status}")
    except urllib.error.HTTPError as e:
        err = e.headers.get("x-vercel-error") if e.headers else None
        if err == "DEPLOYMENT_NOT_FOUND":
            print(f"  BROKEN {host} → DEPLOYMENT_NOT_FOUND")
            broken.append(host)
        else:
            print(f"  edge {host} → HTTP {e.code}")
    except Exception as e:
        print(f"  BROKEN {host} → {e}")
        broken.append(host)

if broken:
    open(os.environ["BROKEN_FILE"], "a").write("\n".join(f"broken:{h}" for h in broken) + "\n")
    print(f"Will repair broken aliases: {' '.join(broken)}")
else:
    print("All edge hosts healthy — no alias repair needed.")
PY

PROD_URL="$(awk -F: '/^prod_url:/ {print substr($0,10); exit}' "$BROKEN_FILE")"
MISSING=()
BROKEN=()
while IFS= read -r line; do
  case "$line" in
    missing:*) MISSING+=("${line#missing:}") ;;
    broken:*) BROKEN+=("${line#broken:}") ;;
  esac
done < "$BROKEN_FILE"
rm -f "$BROKEN_FILE"

if ((${#MISSING[@]})) || ((${#BROKEN[@]})); then
  if ! command -v vercel >/dev/null 2>&1; then
    echo "Need Vercel CLI to repair domains/aliases." >&2
    exit 1
  fi
fi

if ((${#MISSING[@]})); then
  echo "Adding missing domains via CLI (never delete existing)..."
  for host in "${MISSING[@]}"; do
    if ! vercel domains add "$host"; then
      echo "FAIL adding domain $host" >&2
      exit 1
    fi
  done
fi

if ((${#BROKEN[@]})); then
  echo "Repairing broken aliases → ${PROD_URL}"
  # Assign api/docs first, www last so deploy tooling prefers the site host.
  ordered=()
  for host in "${BROKEN[@]}"; do
    if [[ "$host" != "www.supercompress.dev" ]]; then
      ordered+=("$host")
    fi
  done
  for host in "${BROKEN[@]}"; do
    if [[ "$host" == "www.supercompress.dev" ]]; then
      ordered+=("$host")
    fi
  done
  for host in "${ordered[@]}"; do
    if ! vercel alias set "$PROD_URL" "$host"; then
      echo "FAIL alias set $host → $PROD_URL" >&2
      exit 1
    fi
    echo "  repaired $host"
  done
fi

# Final edge gate — never leave DEPLOYMENT_NOT_FOUND uncaught.
fail=0
for host in www.supercompress.dev api.supercompress.dev docs.supercompress.dev; do
  headers="$(mktemp)"
  code="$(curl -sS -D "$headers" -o /dev/null --max-time 25 -w '%{http_code}' "https://${host}/" || echo 000)"
  if grep -qi 'x-vercel-error:[[:space:]]*DEPLOYMENT_NOT_FOUND' "$headers"; then
    echo "FAIL $host still returns DEPLOYMENT_NOT_FOUND" >&2
    fail=1
  elif [[ "$code" == "000" ]]; then
    echo "FAIL $host unreachable" >&2
    fail=1
  else
    echo "  final $host → HTTP $code"
  fi
  rm -f "$headers"
done

if ((fail)); then
  exit 1
fi

echo "Production domains OK."
