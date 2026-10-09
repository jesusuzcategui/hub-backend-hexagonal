#!/usr/bin/env bash
# Shared config and helpers for scripts/local-up.sh and scripts/local-down.sh. Sourced, never run directly.
#
# Every value below can be overridden from the environment, e.g.
#   HUB_DB_NAME=hubdb scripts/local-up.sh
#   CALDAV_SYNC_ENABLED=true scripts/local-up.sh     (passed through to the hub)

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUB_DIR="${HUB_DIR:-$(cd "$LIB_DIR/../.." && pwd)}"
ASTRO_DIR="${ASTRO_DIR:-$HUB_DIR/../design_handoff_portfolio_contentful/Development}"
CAMPUS_DIR="${CAMPUS_DIR:-$HUB_DIR/../../node/jesusuzcategui-campus}"

HUB_PORT="${HUB_PORT:-3003}"
ASTRO_PORT="${ASTRO_PORT:-4321}"
CAMPUS_PORT="${CAMPUS_PORT:-3402}"

# The hub runs against the smoke copy of the database (container pgtest), never against the dev hubdb by accident.
HUB_DB_NAME="${HUB_DB_NAME:-hubstg_smoke}"
HUB_DB_URL="${HUB_DB_URL:-postgres://postgres:x@localhost:5433/$HUB_DB_NAME}"
PG_CONTAINER="${PG_CONTAINER:-pgtest}"
REDIS_CONTAINER="${REDIS_CONTAINER:-hub-backend-hexagonal_redis_1}"

HUB_START_CMD="${HUB_START_CMD:-pnpm dev}"
ASTRO_START_CMD="${ASTRO_START_CMD:-pnpm dev}"
CAMPUS_START_CMD="${CAMPUS_START_CMD:-pnpm dev}"

# One ngrok agent with three endpoints (a single agent session, so it works on any ngrok plan). The user's own
# config (authtoken) is merged under a generated file that maps these domains to the ports above.
HUB_NGROK_URL="${HUB_NGROK_URL:-https://trichotomous-chrystal-dilly.ngrok-free.dev}"
ASTRO_NGROK_URL="${ASTRO_NGROK_URL:-https://jesusuzcategui.ngrok.app}"
CAMPUS_NGROK_URL="${CAMPUS_NGROK_URL:-https://campus.jesusuzcategui.ngrok.app}"
NGROK_CONFIG_USER="${NGROK_CONFIG_USER:-$HOME/.config/ngrok/ngrok.yml}"
NGROK_API="${NGROK_API:-http://127.0.0.1:4040/api/tunnels}"

STATE_DIR="${LOCAL_STACK_STATE_DIR:-$HUB_DIR/.local-stack}"
PID_DIR="$STATE_DIR/pids"
LOG_DIR="$STATE_DIR/logs"
NGROK_CONFIG_STACK="$STATE_DIR/ngrok-endpoints.yml"

DRY_RUN=0

if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_RED=''; C_GRN=''; C_YEL=''; C_DIM=''; C_OFF=''
fi

info() { printf '%s\n' "$*"; }
ok()   { printf '%s✔%s %s\n' "$C_GRN" "$C_OFF" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YEL" "$C_OFF" "$*" >&2; }
die()  { printf '%s✘%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

# run <cmd...>: executes, or only prints under --dry-run.
run() {
  if [ "$DRY_RUN" = 1 ]; then printf '%s+ %s%s\n' "$C_DIM" "$*" "$C_OFF"; return 0; fi
  "$@"
}

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"; }

pid_file() { printf '%s/%s.pid' "$PID_DIR" "$1"; }

write_ngrok_config() {
  cat >"$NGROK_CONFIG_STACK" <<EOF
version: 3
endpoints:
  - name: hub
    url: $HUB_NGROK_URL
    upstream:
      url: $HUB_PORT
  - name: astro
    url: $ASTRO_NGROK_URL
    upstream:
      url: $ASTRO_PORT
  - name: campus
    url: $CAMPUS_NGROK_URL
    upstream:
      url: $CAMPUS_PORT
EOF
}

# True when the pid file of <service> points at a live process.
service_alive() {
  local f pid
  f="$(pid_file "$1")"
  [ -f "$f" ] || return 1
  pid="$(cat "$f" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

port_busy() { [ -n "$(ss -ltnH "( sport = :$1 )" 2>/dev/null)" ]; }

# PIDs listening on a TCP port (empty when none).
port_pids() { fuser "$1"/tcp 2>/dev/null | tr -s ' ' '\n' | sed '/^$/d' | tr '\n' ' ' || true; }

# stop_group <service>: TERM the whole process group of a service started by local-up.sh, KILL after 10 s.
stop_group() {
  local name="$1" f pid i
  f="$(pid_file "$name")"
  if ! service_alive "$name"; then rm -f "$f"; return 1; fi
  pid="$(cat "$f")"
  run kill -TERM -- "-$pid" 2>/dev/null || run kill -TERM "$pid" 2>/dev/null || true
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  for i in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    warn "$name did not stop in 10 s, sending KILL"
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$f"
  return 0
}
