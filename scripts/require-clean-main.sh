#!/usr/bin/env bash
# Refuse to deploy anything but a clean checkout of the latest github main.
# Deploys upload the working tree, so uncommitted or unmerged work would go live.
# Override (emergencies only, logged): SC_DEPLOY_ALLOW_DIRTY=1
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${SC_DEPLOY_ALLOW_DIRTY:-}" == "1" ]]; then
  echo "WARNING: SC_DEPLOY_ALLOW_DIRTY=1 — skipping the clean-main check." >&2
  exit 0
fi

REMOTE="${SC_DEPLOY_REMOTE:-github}"
if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  REMOTE=origin
fi
git fetch --quiet "$REMOTE" main

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Refusing to deploy: the working tree has uncommitted changes." >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

HEAD_SHA="$(git rev-parse HEAD)"
MAIN_SHA="$(git rev-parse "$REMOTE/main")"
if [[ "$HEAD_SHA" != "$MAIN_SHA" ]]; then
  echo "Refusing to deploy: HEAD ($HEAD_SHA) is not $REMOTE/main ($MAIN_SHA)." >&2
  echo "Deploy from a clean worktree of main: git worktree add /tmp/sc-deploy $REMOTE/main" >&2
  exit 1
fi
echo "Deploying $REMOTE/main @ ${HEAD_SHA:0:12} (clean)."
