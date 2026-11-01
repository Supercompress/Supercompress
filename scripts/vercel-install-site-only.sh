#!/usr/bin/env bash
# Vercel hosts the marketing site only. API runs on Fly (supercompress-api).
set -euo pipefail
npm ci --omit=optional --ignore-scripts --no-audit --no-fund
# Prevent Vercel from packaging /api as Fluid serverless (cost + dual-host drift).
rm -rf api
echo "vercel-install: site-only (api/ removed from build tree)"
