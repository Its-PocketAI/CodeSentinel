#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${CODESENTINEL_UPDATE_REMOTE:-origin}"
ALLOW_DIRTY="${CODESENTINEL_UPDATE_ALLOW_DIRTY:-0}"
UPDATE_MODE="${CODESENTINEL_UPDATE_MODE:-tag}"
TAG_RAW="${CODESENTINEL_UPDATE_TAG:-latest}"

fail() {
  echo "[error] $*"
  exit 1
}

normalize_tag_ref() {
  local raw="${1:-}"
  raw="${raw//[[:space:]]/}"
  [[ -n "$raw" ]] || fail "empty tag value"
  if [[ "$raw" == v* ]]; then
    printf '%s' "$raw"
  else
    printf 'v%s' "$raw"
  fi
}

resolve_latest_tag_from_remote() {
  local remote_url="$1"
  local tags
  tags="$(git ls-remote --tags --refs --sort='version:refname' "$remote_url" 2>/dev/null | awk '{print $2}' | sed 's#refs/tags/##' | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' || true)"
  [[ -n "$tags" ]] || return 1
  printf '%s\n' "$tags" | tail -n 1
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
if [[ -n "${CODESENTINEL_UPDATE_BRANCH:-}" ]]; then
  UPDATE_MODE="branch"
fi

if [[ "$ALLOW_DIRTY" != "1" ]] && [[ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
  fail "Working tree has local changes. Commit/stash first, or set CODESENTINEL_UPDATE_ALLOW_DIRTY=1."
fi

echo "[info] Stopping service (if running)..."
"$ROOT_DIR/run/prod-stop.sh" || true

if [[ "$UPDATE_MODE" == "branch" ]]; then
  echo "[info] Fetching latest code from $REMOTE/$BRANCH ..."
  git -C "$ROOT_DIR" fetch "$REMOTE" "$BRANCH" --tags

  if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
    echo "[info] Switching branch to $BRANCH ..."
    git -C "$ROOT_DIR" checkout "$BRANCH"
  fi

  echo "[info] Pulling latest code ..."
  git -C "$ROOT_DIR" pull --ff-only "$REMOTE" "$BRANCH"
else
  REMOTE_URL="$(git -C "$ROOT_DIR" remote get-url "$REMOTE" 2>/dev/null || true)"
  [[ -n "$REMOTE_URL" ]] || fail "Cannot resolve remote URL for $REMOTE"
  echo "[info] Fetching latest tags from $REMOTE ..."
  git -C "$ROOT_DIR" fetch "$REMOTE" --tags

  if [[ -z "$TAG_RAW" || "$TAG_RAW" == "latest" ]]; then
    TARGET_TAG="$(resolve_latest_tag_from_remote "$REMOTE_URL" || true)"
    if [[ -z "$TARGET_TAG" ]]; then
      echo "[warn] No stable tags found on remote; falling back to branch mode ($BRANCH)."
      git -C "$ROOT_DIR" fetch "$REMOTE" "$BRANCH" --tags
      if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
        echo "[info] Switching branch to $BRANCH ..."
        git -C "$ROOT_DIR" checkout "$BRANCH"
      fi
      echo "[info] Pulling latest code ..."
      git -C "$ROOT_DIR" pull --ff-only "$REMOTE" "$BRANCH"
    else
      echo "[info] Updating to tag $TARGET_TAG ..."
      git -C "$ROOT_DIR" fetch "$REMOTE" "refs/tags/$TARGET_TAG:refs/tags/$TARGET_TAG"
      git -C "$ROOT_DIR" checkout --detach "$TARGET_TAG"
    fi
  else
    TARGET_TAG="$(normalize_tag_ref "$TAG_RAW")"
    echo "[info] Updating to tag $TARGET_TAG ..."
    git -C "$ROOT_DIR" fetch "$REMOTE" "refs/tags/$TARGET_TAG:refs/tags/$TARGET_TAG"
    git -C "$ROOT_DIR" checkout --detach "$TARGET_TAG"
  fi
fi

echo "[info] Installing dependencies ..."
cd "$ROOT_DIR"
pnpm install --frozen-lockfile

echo "[info] Starting service ..."
"$ROOT_DIR/run/prod-start.sh"

echo "[ok] Update completed."
