#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/run/prod.pid"
LOG_DIR="$ROOT_DIR/logs"
LOG_FILE="$LOG_DIR/prod.log"

is_codesentinel_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 1
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  local cmdline
  cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  [[ "$cmdline" == *"pnpm start"* ]] || [[ "$cmdline" == *"apps/server/dist/index.js"* ]] || [[ "$cmdline" == *"CODESENTINEL_SERVE_WEB=1"* ]]
}

resolve_default_user() {
  if [[ -n "${CODESENTINEL_DEFAULT_USER:-}" ]]; then
    echo "$CODESENTINEL_DEFAULT_USER"
    return
  fi
  local u=""
  if [[ -f "$ROOT_DIR/config/config.json" ]] && command -v node >/dev/null 2>&1; then
    u="$(node -e 'try{const c=require(process.argv[1]); const v=(c.defaultProjectUser||"").trim(); if(v) process.stdout.write(v);}catch(e){process.exit(0)}' "$ROOT_DIR/config/config.json" 2>/dev/null || true)"
  fi
  if [[ -z "$u" ]]; then u="codesentinel"; fi
  echo "$u"
}

ensure_user() {
  local u="$1"
  if id -u "$u" >/dev/null 2>&1; then
    return
  fi
  if command -v useradd >/dev/null 2>&1; then
    useradd -m -s /bin/bash "$u"
  elif command -v adduser >/dev/null 2>&1; then
    adduser --disabled-password --gecos "" "$u"
  else
    echo "[warn] useradd/adduser not found; cannot create user $u"
  fi
}

if [[ "$(id -u)" -ne 0 ]]; then
  export CODESENTINEL_DEFAULT_USER="${CODESENTINEL_DEFAULT_USER:-${USER:-}}"
else
  DEFAULT_USER="$(resolve_default_user)"
  export CODESENTINEL_DEFAULT_USER="$DEFAULT_USER"
  if [[ "$DEFAULT_USER" == "root" ]]; then
    echo "[warn] running terminals as root is dangerous; use only if fully trusted."
  else
    ensure_user "$DEFAULT_USER"
  fi
fi

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${PID}" ]] && kill -0 "$PID" 2>/dev/null; then
    if is_codesentinel_pid "$PID"; then
      echo "Already running (pid $PID)"
      exit 0
    fi
    echo "Stale pid file detected (pid $PID belongs to another process), cleaning up."
    rm -f "$PID_FILE"
  else
    rm -f "$PID_FILE"
  fi
fi

mkdir -p "$LOG_DIR"

cd "$ROOT_DIR"
pnpm build >> "$LOG_FILE" 2>&1

if command -v setsid >/dev/null 2>&1; then
  setsid bash -lc "cd \"$ROOT_DIR\" && CODESENTINEL_SERVE_WEB=1 NODE_ENV=production exec pnpm start >> \"$LOG_FILE\" 2>&1" &
  echo $! > "$PID_FILE"
else
  nohup bash -lc "cd \"$ROOT_DIR\" && CODESENTINEL_SERVE_WEB=1 NODE_ENV=production exec pnpm start >> \"$LOG_FILE\" 2>&1" >/dev/null 2>&1 &
  echo $! > "$PID_FILE"
fi

sleep 2
PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [[ -z "${PID}" ]] || ! kill -0 "$PID" 2>/dev/null; then
  echo "Failed to start. Check $LOG_FILE"
  exit 1
fi
echo "Started (pid $PID)"
