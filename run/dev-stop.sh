#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/run/dev.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "Not running (pid file missing)"
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [[ -z "${PID}" ]]; then
  rm -f "$PID_FILE"
  echo "Not running (pid empty)"
  exit 0
fi

if kill -0 "$PID" 2>/dev/null; then
  kill -TERM "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
  for _ in {1..20}; do
    if kill -0 "$PID" 2>/dev/null; then
      sleep 0.5
    else
      break
    fi
  done
  if kill -0 "$PID" 2>/dev/null; then
    kill -KILL "-$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true
  fi
fi

rm -f "$PID_FILE"
echo "Stopped"
