#!/usr/bin/env bash
# Stops the local stack started by scripts/local-up.sh (ngrok, campus, Astro, hub).
#
#   scripts/local-down.sh [--force] [--containers] [--dry-run]
#
#   --force        also free the ports (and kill any ngrok) held by processes NOT started by local-up.sh,
#                  e.g. a hub you launched by hand in another terminal
#   --containers   also stop the Postgres and Redis containers (default: leave them running, the test
#                  suites share them)
set -euo pipefail
# shellcheck source=lib/local-stack.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/local-stack.sh"

FORCE=0
CONTAINERS=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --containers) CONTAINERS=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $arg (try --help)" ;;
  esac
done

need_cmd fuser
need_cmd ss

stopped=0
stuck=0

# kill_port_owner <port> <signal>: signals whatever listens on the port. When the listener belongs to a process
# group whose leader is NOT a shell (a `pnpm dev` / `tsx watch` job you started by hand), the whole group is
# signalled, otherwise the watcher parent survives and relaunches the server on the next file change.
# A group led by a shell is never signalled as a group: that could take your terminal down with it.
kill_port_owner() {
  local port="$1" sig="$2" pid pgid leader
  for pid in $(port_pids "$port"); do
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    leader="$(ps -o comm= -p "${pgid:-0}" 2>/dev/null || true)"
    case "$leader" in
      ""|bash|zsh|fish|sh|dash|ksh|tmux*|sshd*|login|systemd*|init)
        run kill "-$sig" "$pid" 2>/dev/null || true ;;
      *)
        run kill "-$sig" -- "-$pgid" 2>/dev/null || run kill "-$sig" "$pid" 2>/dev/null || true ;;
    esac
  done
}

stop_service() {
  local name="$1" port="${2:-}"
  if stop_group "$name"; then
    ok "$name stopped"
    stopped=$((stopped + 1))
  else
    info "  $name was not running (by this script)"
  fi
  [ -n "$port" ] || return 0
  if port_busy "$port"; then
    if [ "$FORCE" = 1 ]; then
      warn "port $port still busy (PID $(port_pids "$port")), freeing it (--force)"
      kill_port_owner "$port" TERM
      if [ "$DRY_RUN" = 0 ]; then
        sleep 1
        # An `if`, not `cmd && cmd`: a freed port must not leave a non-zero status that set -e turns into an abort.
        if port_busy "$port"; then
          kill_port_owner "$port" KILL
          sleep 1
        fi
        if port_busy "$port"; then
          warn "port $port is STILL busy after KILL"
          stuck=$((stuck + 1))
        fi
      fi
    else
      warn "port $port is still in use by PID $(port_pids "$port")(started outside this script). Use --force to stop it"
      stuck=$((stuck + 1))
    fi
  fi
  return 0
}

# Reverse order of local-up.sh: tunnels first, then the apps.
stop_service ngrok
if [ "$FORCE" = 1 ] && pgrep -x ngrok >/dev/null 2>&1; then
  warn "killing ngrok processes not started by this script (--force)"
  run pkill -TERM -x ngrok || true
fi
stop_service campus "$CAMPUS_PORT"
stop_service astro "$ASTRO_PORT"
stop_service hub "$HUB_PORT"

if [ "$CONTAINERS" = 1 ]; then
  need_cmd podman
  warn "stopping containers $PG_CONTAINER and $REDIS_CONTAINER (test suites use them too)"
  run podman stop "$PG_CONTAINER" "$REDIS_CONTAINER" >/dev/null
  ok "containers stopped"
else
  info "  containers $PG_CONTAINER and $REDIS_CONTAINER left running (use --containers to stop them)"
fi

info ""
if [ "$stuck" -gt 0 ]; then
  warn "$stuck port(s) still busy: run scripts/local-down.sh --force"
  exit 1
fi
ok "Local stack is down ($stopped service(s) stopped)"
