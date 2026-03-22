#!/usr/bin/env bash
set -euo pipefail

# CodeSentinel one-line installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Its-PocketAI/CodeSentinel/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/Its-PocketAI/CodeSentinel/main/install.sh | bash -s -- --for-user=zh
#
# Optional env vars:
#   CODESENTINEL_REPO   (default: https://github.com/Its-PocketAI/CodeSentinel.git)
#   CODESENTINEL_VERSION (default: latest; installs latest stable tag such as v0.0.1)
#   CODESENTINEL_BRANCH (optional branch override; when set, branch mode is used instead of tag mode)
#   CODESENTINEL_DIR    (default: $HOME/CodeSentinel)
#   CODESENTINEL_START  (default: 1; set 0 to skip auto start)
#   CODESENTINEL_INTERACTIVE (default: auto; 1=force prompt, 0=skip prompt)
#   CODESENTINEL_PORT   (default: read from config, fallback 3990)
#   CODESENTINEL_AUTH_USER (default: read from config, fallback admin)
#   CODESENTINEL_AUTH_PASS (default: read from config, fallback change_me)
#   CODESENTINEL_HEALTH_TIMEOUT_SEC (default: 60; startup health wait timeout)
#   CODESENTINEL_FOR_USER (default: global; set zh for mainland China mirror profile)
#   CODESENTINEL_ZH_NPM_REGISTRY (default: https://registry.npmmirror.com)

REPO_URL="${CODESENTINEL_REPO:-https://github.com/Its-PocketAI/CodeSentinel.git}"
VERSION_RAW="${CODESENTINEL_VERSION:-latest}"
BRANCH_SET=0
if [[ -n "${CODESENTINEL_BRANCH+x}" ]]; then
  BRANCH_SET=1
fi
BRANCH="${CODESENTINEL_BRANCH:-main}"
INSTALL_DIR="${CODESENTINEL_DIR:-$HOME/CodeSentinel}"
AUTO_START="${CODESENTINEL_START:-1}"
INTERACTIVE_MODE="${CODESENTINEL_INTERACTIVE:-auto}"
FOR_USER_PROFILE="${CODESENTINEL_FOR_USER:-global}"
ZH_NPM_REGISTRY="${CODESENTINEL_ZH_NPM_REGISTRY:-https://registry.npmmirror.com}"
CFG_PATH="config/config.json"
TTY_DEV=""
INSTALL_ENV_VARS=()
TARGET_KIND=""
TARGET_REF=""

if [[ -r /dev/tty && -w /dev/tty ]]; then
  TTY_DEV="/dev/tty"
fi

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
  if [[ -n "$TTY_DEV" ]]; then
    if [[ -n "$def" ]]; then
      read -r -p "[CodeSentinel] $label [$def]: " val < "$TTY_DEV" || true
      val="${val:-$def}"
    else
      read -r -p "[CodeSentinel] $label: " val < "$TTY_DEV" || true
    fi
  else
    if [[ -n "$def" ]]; then
      read -r -p "[CodeSentinel] $label [$def]: " val || true
      val="${val:-$def}"
    else
      read -r -p "[CodeSentinel] $label: " val || true
    fi
  fi
  printf '%s' "$val"
}

prompt_secret() {
  local label="$1"
  local def="${2:-}"
  local val=""
  if [[ -n "$TTY_DEV" ]]; then
    if [[ -n "$def" ]]; then
      read -r -s -p "[CodeSentinel] $label [hidden, press Enter to keep current]: " val < "$TTY_DEV" || true
      echo > "$TTY_DEV"
      val="${val:-$def}"
    else
      read -r -s -p "[CodeSentinel] $label: " val < "$TTY_DEV" || true
      echo > "$TTY_DEV"
    fi
  else
    if [[ -n "$def" ]]; then
      read -r -s -p "[CodeSentinel] $label [hidden, press Enter to keep current]: " val || true
      echo
      val="${val:-$def}"
    else
      read -r -s -p "[CodeSentinel] $label: " val || true
      echo
    fi
  fi
  printf '%s' "$val"
}

print_usage() {
  cat <<'EOF'
CodeSentinel installer

Usage:
  install.sh [--for-user <profile>] [--version <tag>] [--branch <branch>]

Profiles:
  global          Default global profile (no mirror override)
  zh              Mainland China profile (npm/pnpm mirror for install phase)

Examples:
  curl -fsSL https://raw.githubusercontent.com/Its-PocketAI/CodeSentinel/main/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/Its-PocketAI/CodeSentinel/main/install.sh | bash -s -- --for-user=zh
  curl -fsSL https://raw.githubusercontent.com/Its-PocketAI/CodeSentinel/main/install.sh | bash -s -- --version=v0.0.1

Environment:
  CODESENTINEL_VERSION=latest
  CODESENTINEL_BRANCH=main
  CODESENTINEL_FOR_USER=zh
  CODESENTINEL_ZH_NPM_REGISTRY=https://registry.npmmirror.com
EOF
}

normalize_for_user_profile() {
  local raw="${1:-global}"
  local lower
  lower="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    global|intl|international)
      printf 'global'
      ;;
    zh|cn|china)
      printf 'zh'
      ;;
    *)
      die "invalid --for-user value: $raw (supported: global, zh)"
      ;;
  esac
}

normalize_tag_ref() {
  local raw="${1:-}"
  raw="${raw//[[:space:]]/}"
  [[ -n "$raw" ]] || die "empty tag value"
  if [[ "$raw" == v* ]]; then
    printf '%s' "$raw"
  else
    printf 'v%s' "$raw"
  fi
}

resolve_latest_tag_from_repo() {
  local repo="$1"
  local tags
  tags="$(git ls-remote --tags --refs --sort='version:refname' "$repo" 2>/dev/null | awk '{print $2}' | sed 's#refs/tags/##' | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' || true)"
  [[ -n "$tags" ]] || return 1
  printf '%s\n' "$tags" | tail -n 1
}

resolve_checkout_target() {
  if [[ "$BRANCH_SET" == "1" ]]; then
    TARGET_KIND="branch"
    TARGET_REF="$BRANCH"
    return
  fi

  local requested="${VERSION_RAW:-latest}"
  if [[ -z "$requested" || "$requested" == "latest" ]]; then
    local latest_tag=""
    latest_tag="$(resolve_latest_tag_from_repo "$REPO_URL" || true)"
    if [[ -n "$latest_tag" ]]; then
      TARGET_KIND="tag"
      TARGET_REF="$latest_tag"
      return
    fi
    TARGET_KIND="branch"
    TARGET_REF="$BRANCH"
    return
  fi

  TARGET_KIND="tag"
  TARGET_REF="$(normalize_tag_ref "$requested")"
}

checkout_target_ref() {
  local repo_dir="$1"
  if [[ "$TARGET_KIND" == "tag" ]]; then
    git -C "$repo_dir" fetch origin "refs/tags/$TARGET_REF:refs/tags/$TARGET_REF"
    git -C "$repo_dir" checkout --detach "$TARGET_REF"
  else
    git -C "$repo_dir" fetch --depth 1 origin "$TARGET_REF"
    git -C "$repo_dir" checkout -B "$TARGET_REF" "origin/$TARGET_REF"
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --for-user)
        shift
        [[ $# -gt 0 ]] || die "--for-user requires a value (global|zh)"
        FOR_USER_PROFILE="$1"
        ;;
      --for-user=*)
        FOR_USER_PROFILE="${1#*=}"
        ;;
      --version)
        shift
        [[ $# -gt 0 ]] || die "--version requires a value (for example: v0.0.1)"
        VERSION_RAW="$1"
        ;;
      --version=*)
        VERSION_RAW="${1#*=}"
        ;;
      --branch)
        shift
        [[ $# -gt 0 ]] || die "--branch requires a value"
        BRANCH="$1"
        BRANCH_SET=1
        ;;
      --branch=*)
        BRANCH="${1#*=}"
        BRANCH_SET=1
        ;;
      -h|--help)
        print_usage
        exit 0
        ;;
      *)
        die "unknown argument: $1 (use --help)"
        ;;
    esac
    shift
  done
}

apply_install_profile() {
  FOR_USER_PROFILE="$(normalize_for_user_profile "$FOR_USER_PROFILE")"
  INSTALL_ENV_VARS=()
  if [[ "$FOR_USER_PROFILE" == "zh" ]]; then
    INSTALL_ENV_VARS=(
      "npm_config_registry=$ZH_NPM_REGISTRY"
      "NPM_CONFIG_REGISTRY=$ZH_NPM_REGISTRY"
      "COREPACK_NPM_REGISTRY=$ZH_NPM_REGISTRY"
      "PNPM_REGISTRY=$ZH_NPM_REGISTRY"
    )
    log "install profile: zh (npm/pnpm mirror: $ZH_NPM_REGISTRY)"
    log "tip: if git clone is slow, set CODESENTINEL_REPO to your own mirror URL"
  else
    log "install profile: global"
  fi
}

run_with_install_env() {
  if (( ${#INSTALL_ENV_VARS[@]} > 0 )); then
    env "${INSTALL_ENV_VARS[@]}" "$@"
  else
    "$@"
  fi
}

parse_args "$@"
apply_install_profile

log "checking prerequisites..."
require_cmd git
require_cmd bash
require_cmd node

resolve_checkout_target

if [[ "$TARGET_KIND" == "tag" ]]; then
  log "install source: stable tag $TARGET_REF"
else
  log "install source: branch $TARGET_REF"
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 18 )); then
  die "Node.js >= 18 is required (current: $(node -v))"
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    log "pnpm not found, enabling via corepack..."
    corepack enable >/dev/null 2>&1 || true
    run_with_install_env corepack prepare pnpm@10.4.0 --activate >/dev/null 2>&1 || die "failed to activate pnpm via corepack"
  else
    die "pnpm not found and corepack is unavailable"
  fi
fi

log "target directory: $INSTALL_DIR"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  log "existing repository detected, updating target..."
  git -C "$INSTALL_DIR" fetch --tags origin
  checkout_target_ref "$INSTALL_DIR"
elif [[ -d "$INSTALL_DIR" ]]; then
  die "directory exists but is not a git repository: $INSTALL_DIR"
else
  log "cloning repository..."
  git clone --depth 1 --branch "$TARGET_REF" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
log "installing dependencies..."
run_with_install_env pnpm install --frozen-lockfile || run_with_install_env pnpm install

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

is_port_in_use() {
  local p="$1"
  node -e 'const net=require("net"); const p=Number(process.argv[1]); if(!Number.isFinite(p)||p<1||p>65535){process.exit(2)} const s=net.createServer(); s.once("error",()=>process.exit(0)); s.once("listening",()=>s.close(()=>process.exit(1))); s.listen(p,"0.0.0.0");' "$p" >/dev/null 2>&1
}

check_health_once() {
  local p="$1"
  node -e '
const http = require("http");
const port = Number(process.argv[1]);
const req = http.request(
  { hostname: "127.0.0.1", port, path: "/healthz", method: "GET", timeout: 1500 },
  (res) => {
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
  }
);
req.on("error", () => process.exit(1));
req.on("timeout", () => {
  req.destroy();
  process.exit(1);
});
req.end();
' "$p" >/dev/null 2>&1
}

wait_for_health() {
  local p="$1"
  local timeout="${CODESENTINEL_HEALTH_TIMEOUT_SEC:-60}"
  if [[ ! "$timeout" =~ ^[0-9]+$ ]] || (( timeout < 1 )); then
    timeout=60
  fi
  local i
  for ((i = 1; i <= timeout; i++)); do
    if check_health_once "$p"; then
      log "healthz is ready: http://localhost:${p}/healthz (wait ${i}s)"
      return 0
    fi
    sleep 1
  done
  return 1
}

if ! check_better_sqlite3; then
  log "native binding missing for better-sqlite3, attempting auto-rebuild..."
  if command -v npm >/dev/null 2>&1; then
    (
      cd "$INSTALL_DIR/apps/server"
      run_with_install_env npm rebuild better-sqlite3 --build-from-source
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
  [[ -n "$TTY_DEV" ]] || die "interactive mode requested but /dev/tty is not available"
  SHOULD_PROMPT=1
elif [[ "$INTERACTIVE_MODE" == "0" ]]; then
  SHOULD_PROMPT=0
elif [[ -t 1 && -n "$TTY_DEV" ]]; then
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
      if is_port_in_use "$SET_PORT"; then
        log "port $SET_PORT is already in use, choose another one"
        continue
      fi
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
  if [[ -n "$TTY_DEV" ]]; then
    read -r -p "[CodeSentinel] Confirm and write to config? [Y/n]: " CONFIRM_WRITE < "$TTY_DEV" || true
  else
    read -r -p "[CodeSentinel] Confirm and write to config? [Y/n]: " CONFIRM_WRITE || true
  fi
  CONFIRM_WRITE="${CONFIRM_WRITE:-Y}"
  if [[ ! "$CONFIRM_WRITE" =~ ^[Yy]$ ]]; then
    die "installation aborted by user"
  fi
else
  if [[ "$SET_PORT" =~ ^[0-9]+$ ]] && (( SET_PORT >= 1 && SET_PORT <= 65535 )); then
    if is_port_in_use "$SET_PORT"; then
      die "port $SET_PORT is already in use; set CODESENTINEL_PORT to a free port"
    fi
  fi
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
  if ! wait_for_health "$SET_PORT"; then
    log "service did not become healthy in time. recent logs:"
    tail -n 60 "$INSTALL_DIR/logs/prod.log" || true
    die "startup health check failed (timeout=${CODESENTINEL_HEALTH_TIMEOUT_SEC:-60}s)"
  fi
else
  log "auto-start skipped (CODESENTINEL_START=$AUTO_START)"
fi

log "done."
log "project path: $INSTALL_DIR"
log "web url:       http://localhost:${SET_PORT}/"
log "health url:    http://localhost:${SET_PORT}/healthz"
log "for first setup: http://localhost:${SET_PORT}/#/setup"
