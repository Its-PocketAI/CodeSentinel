#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${CODESENTINEL_UPDATE_REMOTE:-origin}"
ALLOW_DIRTY="${CODESENTINEL_UPDATE_ALLOW_DIRTY:-0}"

fail() {
  echo "[error] $*"
  exit 1
}

if ! command -v git >/dev/null 2>&1; then
  fail "git not found in PATH."
fi
if ! command -v pnpm >/dev/null 2>&1; then
  fail "pnpm not found in PATH."
fi
if ! git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  fail "This directory is not a git repository: $ROOT_DIR"
fi

CURRENT_BRANCH="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [[ -z "${CURRENT_BRANCH}" || "${CURRENT_BRANCH}" == "HEAD" ]]; then
  CURRENT_BRANCH="main"
fi
BRANCH="${CODESENTINEL_UPDATE_BRANCH:-$CURRENT_BRANCH}"

if [[ "$ALLOW_DIRTY" != "1" ]] && [[ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
  fail "Working tree has local changes. Commit/stash first, or set CODESENTINEL_UPDATE_ALLOW_DIRTY=1."
fi

echo "[info] Stopping service (if running)..."
"$ROOT_DIR/run/prod-stop.sh" || true

echo "[info] Fetching latest code from $REMOTE/$BRANCH ..."
git -C "$ROOT_DIR" fetch "$REMOTE" "$BRANCH" --tags

if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
  echo "[info] Switching branch to $BRANCH ..."
  git -C "$ROOT_DIR" checkout "$BRANCH"
fi

echo "[info] Pulling latest code ..."
git -C "$ROOT_DIR" pull --ff-only "$REMOTE" "$BRANCH"

echo "[info] Installing dependencies ..."
cd "$ROOT_DIR"
pnpm install --frozen-lockfile

echo "[info] Starting service ..."
"$ROOT_DIR/run/prod-start.sh"

echo "[ok] Update completed."
