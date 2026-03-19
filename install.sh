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
#   CODESENTINEL_INTERACTIVE (default: auto; 1=force prompt, 0=skip prompt)
#   CODESENTINEL_PORT   (default: read from config, fallback 3990)
#   CODESENTINEL_AUTH_USER (default: read from config, fallback admin)
#   CODESENTINEL_AUTH_PASS (default: read from config, fallback change_me)

REPO_URL="${CODESENTINEL_REPO:-https://github.com/Its-PocketAI/CodeSentinel.git}"
BRANCH="${CODESENTINEL_BRANCH:-main}"
INSTALL_DIR="${CODESENTINEL_DIR:-$HOME/CodeSentinel}"
AUTO_START="${CODESENTINEL_START:-1}"
INTERACTIVE_MODE="${CODESENTINEL_INTERACTIVE:-auto}"
CFG_PATH="config/config.json"

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

prompt_text() {
  local label="$1"
  local def="${2:-}"
  local val=""
  if [[ -n "$def" ]]; then
    read -r -p "[CodeSentinel] $label [$def]: " val || true
    val="${val:-$def}"
  else
    read -r -p "[CodeSentinel] $label: " val || true
  fi
  printf '%s' "$val"
}

prompt_secret() {
  local label="$1"
  local def="${2:-}"
  local val=""
  if [[ -n "$def" ]]; then
    read -r -s -p "[CodeSentinel] $label [hidden, press Enter to keep current]: " val || true
    echo
    val="${val:-$def}"
  else
    read -r -s -p "[CodeSentinel] $label: " val || true
    echo
  fi
  printf '%s' "$val"
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

check_better_sqlite3() {
  node - <<'NODE'
const { createRequire } = require("module");
try {
  const req = createRequire(process.cwd() + "/apps/server/package.json");
  const BetterSqlite3 = req("better-sqlite3");
  const db = new BetterSqlite3(":memory:");
  db.prepare("select 1").get();
  db.close();
  process.exit(0);
} catch {
  process.exit(1);
}
NODE
}

if ! check_better_sqlite3; then
  log "native binding missing for better-sqlite3, attempting auto-rebuild..."
  if command -v npm >/dev/null 2>&1; then
    (
      cd "$INSTALL_DIR/apps/server"
      npm rebuild better-sqlite3 --build-from-source
    ) || die "failed to rebuild better-sqlite3"
  else
    die "npm is required to rebuild better-sqlite3 (not found)"
  fi
  check_better_sqlite3 || die "better-sqlite3 is still unavailable after rebuild"
  log "better-sqlite3 binding is ready"
fi

mkdir -p config
if [[ ! -f config/config.json ]] && [[ -f config/config.example.json ]]; then
  cp config/config.example.json config/config.json
  log "created config/config.json from example"
fi

[[ -f "$CFG_PATH" ]] || die "missing $CFG_PATH"

DEFAULT_PORT="$(node -e 'const fs=require("fs");let c={};try{c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));}catch{};const p=Number(c?.server?.port);process.stdout.write(String(Number.isFinite(p)&&p>=1&&p<=65535?Math.round(p):3990));' "$CFG_PATH")"
DEFAULT_USER="$(node -e 'const fs=require("fs");let c={};try{c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));}catch{};const u=(c?.auth?.username||"").trim();process.stdout.write(u||"admin");' "$CFG_PATH")"
DEFAULT_PASS="$(node -e 'const fs=require("fs");let c={};try{c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));}catch{};const p=(c?.auth?.password||"").trim();process.stdout.write(p||"change_me");' "$CFG_PATH")"

SET_PORT="${CODESENTINEL_PORT:-$DEFAULT_PORT}"
SET_AUTH_USER="${CODESENTINEL_AUTH_USER:-$DEFAULT_USER}"
SET_AUTH_PASS="${CODESENTINEL_AUTH_PASS:-$DEFAULT_PASS}"

SHOULD_PROMPT=0
if [[ "$INTERACTIVE_MODE" == "1" ]]; then
  SHOULD_PROMPT=1
elif [[ "$INTERACTIVE_MODE" == "0" ]]; then
  SHOULD_PROMPT=0
elif [[ -t 0 && -t 1 ]]; then
  SHOULD_PROMPT=1
fi

if [[ "$SHOULD_PROMPT" == "1" ]]; then
  log "configure login account, password and service port"
  while true; do
    SET_AUTH_USER="$(prompt_text "Login username" "$SET_AUTH_USER")"
    [[ -n "$SET_AUTH_USER" ]] && break
    log "username cannot be empty"
  done
  while true; do
    SET_AUTH_PASS="$(prompt_secret "Login password" "$SET_AUTH_PASS")"
    [[ -n "$SET_AUTH_PASS" ]] && break
    log "password cannot be empty"
  done
  while true; do
    SET_PORT="$(prompt_text "Service port" "$SET_PORT")"
    if [[ "$SET_PORT" =~ ^[0-9]+$ ]] && (( SET_PORT >= 1 && SET_PORT <= 65535 )); then
      break
    fi
    log "port must be a number between 1 and 65535"
  done

  echo
  log "please save the following settings now:"
  printf '  username: %s\n' "$SET_AUTH_USER"
  printf '  password: %s\n' "$SET_AUTH_PASS"
  printf '  port: %s\n' "$SET_PORT"
  printf '  config: %s/%s\n' "$INSTALL_DIR" "$CFG_PATH"
  read -r -p "[CodeSentinel] Confirm and write to config? [Y/n]: " CONFIRM_WRITE || true
  CONFIRM_WRITE="${CONFIRM_WRITE:-Y}"
  if [[ ! "$CONFIRM_WRITE" =~ ^[Yy]$ ]]; then
    die "installation aborted by user"
  fi
else
  log "non-interactive mode: using configured/env credentials and port"
fi

node - "$CFG_PATH" "$SET_PORT" "$SET_AUTH_USER" "$SET_AUTH_PASS" <<'NODE'
const fs = require("fs");
const cfgPath = process.argv[2];
const port = Number(process.argv[3]);
const username = String(process.argv[4] || "");
const password = String(process.argv[5] || "");

let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
} catch {}
if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) cfg = {};
if (!cfg.server || typeof cfg.server !== "object" || Array.isArray(cfg.server)) cfg.server = {};
if (!cfg.auth || typeof cfg.auth !== "object" || Array.isArray(cfg.auth)) cfg.auth = {};

cfg.server.port = port;
cfg.auth.enabled = cfg.auth.enabled !== false;
cfg.auth.username = username;
cfg.auth.password = password;

fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
NODE

log "configuration written: $INSTALL_DIR/$CFG_PATH"
log "you can review or edit these values later in config/config.json"
log "please keep your username/password in a safe place"

if [[ "$AUTO_START" == "1" ]]; then
  log "starting production service..."
  ./run/prod-start.sh
else
  log "auto-start skipped (CODESENTINEL_START=$AUTO_START)"
fi

log "done."
log "project path: $INSTALL_DIR"
log "web url:       http://localhost:${SET_PORT}/"
log "health url:    http://localhost:${SET_PORT}/healthz"
log "for first setup: http://localhost:${SET_PORT}/#/setup"
