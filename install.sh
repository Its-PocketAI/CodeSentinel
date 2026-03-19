#!/usr/bin/env bash
set -euo pipefail

# CodeSentinel one-line installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Its-PocketAI/CodeSentinel/main/install.sh | bash
#
# Optional env vars:
#   CODESENTINEL_REPO   (default: https://github.com/Its-PocketAI/CodeSentinel.git)
#   CODESENTINEL_BRANCH (default: main)
#   CODESENTINEL_DIR    (default: $HOME/CodeSentinel)
#   CODESENTINEL_START  (default: 1; set 0 to skip auto start)

REPO_URL="${CODESENTINEL_REPO:-https://github.com/Its-PocketAI/CodeSentinel.git}"
BRANCH="${CODESENTINEL_BRANCH:-main}"
INSTALL_DIR="${CODESENTINEL_DIR:-$HOME/CodeSentinel}"
AUTO_START="${CODESENTINEL_START:-1}"

log() {
  printf '[CodeSentinel] %s\n' "$*"
}

die() {
  printf '[CodeSentinel][ERROR] %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || die "missing required command: $cmd"
}

log "checking prerequisites..."
require_cmd git
require_cmd bash
require_cmd node

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 18 )); then
  die "Node.js >= 18 is required (current: $(node -v))"
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    log "pnpm not found, enabling via corepack..."
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@10.4.0 --activate >/dev/null 2>&1 || die "failed to activate pnpm via corepack"
  else
    die "pnpm not found and corepack is unavailable"
  fi
fi

log "target directory: $INSTALL_DIR"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  log "existing repository detected, updating..."
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
elif [[ -d "$INSTALL_DIR" ]]; then
  die "directory exists but is not a git repository: $INSTALL_DIR"
else
  log "cloning repository..."
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
log "installing dependencies..."
pnpm install --frozen-lockfile || pnpm install

mkdir -p config
if [[ ! -f config/config.json ]] && [[ -f config/config.example.json ]]; then
  cp config/config.example.json config/config.json
  log "created config/config.json from example"
fi

if [[ "$AUTO_START" == "1" ]]; then
  log "starting production service..."
  ./run/prod-start.sh
else
  log "auto-start skipped (CODESENTINEL_START=$AUTO_START)"
fi

log "done."
log "project path: $INSTALL_DIR"
log "web url:       http://localhost:3990/"
log "health url:    http://localhost:3990/healthz"
log "for first setup: http://localhost:3990/#/setup"
