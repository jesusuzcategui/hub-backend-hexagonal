#!/usr/bin/env bash
# Starts the local stack: containers (Postgres smoke copy + Redis), hub, Astro, campus and the three ngrok tunnels.
#
#   scripts/local-up.sh [--no-tunnels] [--dry-run]
#
# Logs: .local-stack/logs/<service>.log   PID files: .local-stack/pids/<service>.pid
# Stop everything with scripts/local-down.sh.
set -euo pipefail
# shellcheck source=lib/local-stack.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/local-stack.sh"

TUNNELS=1
for arg in "$@"; do
  case "$arg" in
    --no-tunnels) TUNNELS=0 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $arg (try --help)" ;;
  esac
done

preflight() {
  local c
  for c in pnpm curl setsid fuser ss; do need_cmd "$c"; done
  [ "${SKIP_CONTAINERS:-0}" = 1 ] || need_cmd podman
  [ "$TUNNELS" = 0 ] || need_cmd ngrok
  [ -d "$HUB_DIR" ] || die "Hub folder not found: $HUB_DIR"
  [ -d "$ASTRO_DIR" ] || die "Astro folder not found: $ASTRO_DIR (set ASTRO_DIR=...)"
  [ -d "$CAMPUS_DIR" ] || die "Campus folder not found: $CAMPUS_DIR (set CAMPUS_DIR=...)"
  if [ "$TUNNELS" = 1 ] && [ ! -f "$NGROK_CONFIG_USER" ]; then
    die "ngrok config not found: $NGROK_CONFIG_USER (run: ngrok config add-authtoken <token>)"
  fi
}

ensure_container() {
  local name="$1"
  podman container exists "$name" || die "Container '$name' does not exist (podman ps -a)"
  if [ "$(podman inspect -f '{{.State.Running}}' "$name")" = true ]; then
    ok "container $name already running"
  else
    run podman start "$name" >/dev/null
    ok "container $name started"
  fi
}

wait_postgres() {
  local i
  [ "$DRY_RUN" = 1 ] && return 0
  for i in $(seq 1 30); do
    podman exec "$PG_CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && return 0
    sleep 1
  done
  die "Postgres in container $PG_CONTAINER is not ready after 30 s"
}

ensure_database() {
  [ "$DRY_RUN" = 1 ] && return 0
  local found
  found="$(podman exec "$PG_CONTAINER" psql -U postgres -Atc "select 1 from pg_database where datname='$HUB_DB_NAME'" 2>/dev/null || true)"
  [ "$found" = 1 ] || die "Database '$HUB_DB_NAME' does not exist in $PG_CONTAINER. Create it, or pick another with HUB_DB_NAME=..."
  ok "database $HUB_DB_NAME present"
}

# start_service <name> <dir> <port> <health-url> <cmd...>   (extra env comes from the caller via env(1))
start_service() {
  local name="$1" dir="$2" port="$3" url="$4"
  shift 4
  if service_alive "$name"; then ok "$name already running (pid $(cat "$(pid_file "$name")"))"; return 0; fi
  if port_busy "$port"; then
    local msg="Port $port is already in use by PID $(port_pids "$port")(not started by this script). Stop it, or run scripts/local-down.sh --force"
    if [ "$DRY_RUN" = 1 ]; then warn "$msg"; return 0; fi
    die "$msg"
  fi
  if [ "$DRY_RUN" = 1 ]; then info "${C_DIM}+ (cd $dir && $* > $LOG_DIR/$name.log)${C_OFF}"; return 0; fi
  : >"$LOG_DIR/$name.log"
  # `;` (not `&&`) so that only the service is backgrounded and $! is its pid. setsid makes it a session/group leader,
  # so local-down.sh can stop pnpm and all of its children with one kill to the group.
  (cd "$dir"; nohup setsid "$@" >>"$LOG_DIR/$name.log" 2>&1 </dev/null & echo $! >"$(pid_file "$name")")
  info "  $name starting (pid $(cat "$(pid_file "$name")")), waiting for $url ..."
  wait_http "$name" "$url" "${WAIT_SECONDS:-180}"
}

wait_http() {
  local name="$1" url="$2" timeout="$3" i code
  for i in $(seq 1 "$timeout"); do
    service_alive "$name" || { tail -n 20 "$LOG_DIR/$name.log" >&2; die "$name exited while starting (log: $LOG_DIR/$name.log). Run scripts/local-down.sh to clean up what already started"; }
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$url" || true)"
    if [ -n "$code" ] && [ "$code" != 000 ]; then ok "$name up ($url -> HTTP $code)"; return 0; fi
    sleep 1
  done
  tail -n 20 "$LOG_DIR/$name.log" >&2
  die "$name did not answer on $url within ${timeout}s (log: $LOG_DIR/$name.log). Run scripts/local-down.sh to clean up what already started"
}

start_tunnels() {
  if service_alive ngrok; then ok "ngrok already running (pid $(cat "$(pid_file ngrok)"))"; return 0; fi
  if pgrep -x ngrok >/dev/null 2>&1; then
    die "Another ngrok is already running (not started by this script). Stop it first, or run scripts/local-down.sh --force"
  fi
  if [ "$DRY_RUN" = 1 ]; then
    info "${C_DIM}+ ngrok start --all --config $NGROK_CONFIG_USER --config $NGROK_CONFIG_STACK${C_OFF}"
    return 0
  fi
  write_ngrok_config
  : >"$LOG_DIR/ngrok.log"
  (nohup setsid ngrok start --all --config "$NGROK_CONFIG_USER" --config "$NGROK_CONFIG_STACK" \
    --log stdout >>"$LOG_DIR/ngrok.log" 2>&1 </dev/null & echo $! >"$(pid_file ngrok)")
  local i
  for i in $(seq 1 30); do
    service_alive ngrok || { tail -n 20 "$LOG_DIR/ngrok.log" >&2; die "ngrok exited while starting (log: $LOG_DIR/ngrok.log)"; }
    if curl -s --max-time 2 "$NGROK_API" 2>/dev/null | grep -q '"public_url"'; then ok "ngrok tunnels up"; return 0; fi
    sleep 1
  done
  tail -n 20 "$LOG_DIR/ngrok.log" >&2
  die "ngrok tunnels did not come up within 30 s (log: $LOG_DIR/ngrok.log)"
}

summary() {
  info ""
  if [ "$DRY_RUN" = 1 ]; then info "Dry run, nothing was started. Plan:"; else info "Local stack is up:"; fi
  printf '  %-8s %-26s %s\n' hub "http://localhost:$HUB_PORT" "$HUB_NGROK_URL"
  printf '  %-8s %-26s %s\n' astro "http://localhost:$ASTRO_PORT" "$ASTRO_NGROK_URL"
  printf '  %-8s %-26s %s\n' campus "http://localhost:$CAMPUS_PORT" "$CAMPUS_NGROK_URL"
  [ "$TUNNELS" = 1 ] || info "  (tunnels not started: --no-tunnels)"
  info ""
  info "Hub database: $HUB_DB_NAME   Logs: $LOG_DIR   Stop: scripts/local-down.sh"
}

preflight
if [ "$DRY_RUN" = 0 ]; then mkdir -p "$PID_DIR" "$LOG_DIR"; fi
[ "${SKIP_CONTAINERS:-0}" = 1 ] || { ensure_container "$PG_CONTAINER"; ensure_container "$REDIS_CONTAINER"; wait_postgres; ensure_database; }

# shellcheck disable=SC2086  # the start commands are intentionally word-split ("pnpm dev")
start_service hub "$HUB_DIR" "$HUB_PORT" "http://localhost:$HUB_PORT/health" env "DATABASE_URL=$HUB_DB_URL" $HUB_START_CMD
# shellcheck disable=SC2086
start_service astro "$ASTRO_DIR" "$ASTRO_PORT" "http://localhost:$ASTRO_PORT/" env $ASTRO_START_CMD
# shellcheck disable=SC2086
start_service campus "$CAMPUS_DIR" "$CAMPUS_PORT" "http://localhost:$CAMPUS_PORT/" env $CAMPUS_START_CMD
[ "$TUNNELS" = 0 ] || start_tunnels
summary
