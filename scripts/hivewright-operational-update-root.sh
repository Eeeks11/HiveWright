#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${HIVEWRIGHT_INSTALL_DIR:-/home/trent/apps/HiveWright}"
RUNTIME_ROOT="${HIVEWRIGHT_RUNTIME_ROOT:-/home/trent/.hivewright}"
ENV_FILE="${HIVEWRIGHT_ENV_FILE:-$RUNTIME_ROOT/config/.env}"
LOG_DIR="$RUNTIME_ROOT/logs/updates"
DEPLOYMENT_DIR="$RUNTIME_ROOT/logs/deployments"
CUTOVER_FILE="$DEPLOYMENT_DIR/latest-runtime-cutover.json"
SERVICE_USER="${HIVEWRIGHT_SERVICE_USER:-trent}"
DASHBOARD_URL="${HIVEWRIGHT_DASHBOARD_HEALTH_URL:-http://localhost:3002}"
CANONICAL_REMOTE_URL="${HIVEWRIGHT_CANONICAL_REMOTE_URL:-https://github.com/Eeeks11/HiveWright.git}"
MODE="${1:-status-json}"

SYSTEMCTL_USER_ENV() {
  local uid
  uid="$(id -u "$SERVICE_USER")"
  env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@"
}

as_service_user() {
  runuser -u "$SERVICE_USER" -- bash -lc "$1"
}

json_escape() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1] ?? ""))' "$1"
}

json_or_null() {
  if [ -n "${1:-}" ]; then
    json_escape "$1"
  else
    printf 'null'
  fi
}

extract_health_build_hash() {
  node -e 'let data=""; process.stdin.on("data", (chunk) => data += chunk); process.stdin.on("end", () => { try { const parsed = JSON.parse(data); const buildHash = parsed?.data?.buildHash ?? parsed?.buildHash ?? ""; process.stdout.write(String(buildHash || "")); } catch {} });'
}

write_cutover_record() {
  local recorded_at="$1"
  local deployed_commit="$2"
  local build_hash="$3"
  local dashboard_pid="$4"
  local dashboard_cwd="$5"
  local dispatcher_pid="$6"
  local dispatcher_cwd="$7"
  local dashboard_pid_json="null"
  local dispatcher_pid_json="null"

  [ -n "$dashboard_pid" ] && [ "$dashboard_pid" != "0" ] && dashboard_pid_json="$dashboard_pid"
  [ -n "$dispatcher_pid" ] && [ "$dispatcher_pid" != "0" ] && dispatcher_pid_json="$dispatcher_pid"

  cat > "$CUTOVER_FILE" <<JSON
{"recordedAt":$(json_escape "$recorded_at"),"runtimeMode":"locked-install","installDir":$(json_escape "$INSTALL_DIR"),"runtimeRoot":$(json_escape "$RUNTIME_ROOT"),"envFile":$(json_escape "$ENV_FILE"),"dashboardHealthUrl":$(json_escape "$DASHBOARD_URL"),"deployedCommit":$(json_escape "$deployed_commit"),"buildHash":$(json_or_null "$build_hash"),"dashboard":{"pid":$dashboard_pid_json,"cwd":$(json_or_null "$dashboard_cwd")},"dispatcher":{"pid":$dispatcher_pid_json,"cwd":$(json_or_null "$dispatcher_cwd")}}
JSON

  chown "$SERVICE_USER:$SERVICE_USER" "$CUTOVER_FILE" 2>/dev/null || true
}

ensure_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "hivewright-operational-update must run as root" >&2
    exit 77
  fi
}

ensure_paths() {
  [ "$INSTALL_DIR" = "/home/trent/apps/HiveWright" ] || { echo "Refusing unexpected install path: $INSTALL_DIR" >&2; exit 20; }
  [ -d "$INSTALL_DIR/.git" ] || { echo "Install dir is not a git checkout: $INSTALL_DIR" >&2; exit 21; }
  mkdir -p "$LOG_DIR" "$DEPLOYMENT_DIR"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$RUNTIME_ROOT/logs" 2>/dev/null || true
}

configure_root_git() {
  git config --global --add safe.directory "$INSTALL_DIR" 2>/dev/null || true
}

remote_matches_canonical() {
  local remote
  remote="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)"
  [ "$remote" = "$CANONICAL_REMOTE_URL" ]
}

ensure_canonical_remote() {
  local remote
  remote="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)"
  if [ "$remote" != "$CANONICAL_REMOTE_URL" ]; then
    echo "Refusing update: origin remote is '$remote', expected '$CANONICAL_REMOTE_URL'." >&2
    echo "Fix with: git -C $INSTALL_DIR remote set-url origin $CANONICAL_REMOTE_URL" >&2
    exit 13
  fi
  local branch
  branch="$(git -C "$INSTALL_DIR" branch --show-current 2>/dev/null || true)"
  if [ "$branch" != "main" ]; then
    echo "Refusing update: operational install must stay on main, currently '$branch'." >&2
    exit 14
  fi
  git -C "$INSTALL_DIR" config branch.main.remote origin
  git -C "$INSTALL_DIR" config branch.main.merge refs/heads/main
}

lock_repo() {
  chown -R root:root "$INSTALL_DIR"
  chmod -R u+rwX,go+rX,go-w "$INSTALL_DIR"
}

repo_dirty_count() {
  git -C "$INSTALL_DIR" status --porcelain | wc -l | tr -d ' '
}

status_json() {
  ensure_root
  ensure_paths
  configure_root_git

  local raw_remote
  raw_remote="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)"
  if [ "$raw_remote" != "$CANONICAL_REMOTE_URL" ]; then
    local version branch current dirty message
    version="$(node -e "console.log(require('$INSTALL_DIR/package.json').version || '0.0.0')" 2>/dev/null || echo "0.0.0")"
    branch="$(git -C "$INSTALL_DIR" branch --show-current 2>/dev/null || true)"
    current="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
    dirty="false"; [ "$(repo_dirty_count)" = "0" ] || dirty="true"
    message="Operational install origin remote is not the canonical GitHub remote; automatic updates are blocked until the remote is restored."
    cat <<JSON
{"status":{"currentVersion":$(json_escape "$version"),"currentCommit":$(json_escape "$current"),"upstreamCommit":"","remoteUrl":$(json_escape "$raw_remote"),"expectedRemoteUrl":$(json_escape "$CANONICAL_REMOTE_URL"),"branch":$(json_escape "$branch"),"dirty":$dirty,"updateAvailable":false,"state":"blocked-remote-misconfigured","message":$(json_escape "$message")},"plan":{"allowed":false,"commands":[],"message":$(json_escape "$message")}}
JSON
    return 0
  fi
  ensure_canonical_remote
  git -C "$INSTALL_DIR" fetch --tags --prune origin >/dev/null 2>&1 || true

  local version branch current upstream remote dirty state update_available message relation plan_allowed plan_message
  version="$(node -e "console.log(require('$INSTALL_DIR/package.json').version || '0.0.0')")"
  branch="$(git -C "$INSTALL_DIR" branch --show-current 2>/dev/null || true)"
  current="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
  upstream="$(git -C "$INSTALL_DIR" rev-parse '@{u}' 2>/dev/null || true)"
  remote="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null | sed -E 's#(https?://)[^/@:]+:[^/@]+@#\1#' || true)"
  dirty="false"
  [ "$(repo_dirty_count)" = "0" ] || dirty="true"
  relation="unknown"
  if [ -n "$current" ] && [ -n "$upstream" ]; then
    if [ "$current" = "$upstream" ]; then
      relation="current"
    elif git -C "$INSTALL_DIR" merge-base --is-ancestor "$current" "$upstream"; then
      relation="behind"
    elif git -C "$INSTALL_DIR" merge-base --is-ancestor "$upstream" "$current"; then
      relation="ahead"
    else
      relation="diverged"
    fi
  fi

  if [ -z "$remote" ] || [ -z "$branch" ] || [ -z "$current" ]; then
    state="not-configured"; update_available="false"; message="This install is not connected to a Git remote/upstream."
  elif [ "$dirty" = "true" ]; then
    state="blocked-dirty-worktree"; update_available="false"; [ -n "$upstream" ] && [ "$upstream" != "$current" ] && update_available="true"; message="Local changes are present. Commit, stash, or discard them before running an automatic update."
  elif [ -z "$upstream" ]; then
    state="unknown"; update_available="false"; message="HiveWright could not resolve the upstream commit for this branch."
  elif [ "$relation" = "diverged" ]; then
    state="blocked-diverged"; update_available="true"; message="This install and the configured Git remote have diverged. Automatic fast-forward update is blocked until the local commits are reconciled."
  elif [ "$relation" = "ahead" ]; then
    state="blocked-local-ahead"; update_available="false"; message="This install has local commits that are not on the configured Git remote. Publish or reset them before using automatic updates."
  elif [ "$relation" = "behind" ]; then
    state="update-available"; update_available="true"; message="A newer HiveWright commit is available from the configured Git remote."
  else
    state="current"; update_available="false"; message="HiveWright is current with the configured Git remote."
  fi

  plan_allowed="false"
  plan_message="No privileged update is currently available."
  if [ "$state" = "update-available" ]; then
    plan_allowed="true"
    plan_message="Update can be applied by the privileged operational updater."
  elif [ "$state" = "blocked-diverged" ] || [ "$state" = "blocked-local-ahead" ] || [ "$state" = "blocked-dirty-worktree" ]; then
    plan_message="$message"
  fi

  cat <<JSON
{"status":{"currentVersion":$(json_escape "$version"),"currentCommit":$(json_escape "$current"),"upstreamCommit":$(json_escape "$upstream"),"remoteUrl":$(json_escape "$remote"),"branch":$(json_escape "$branch"),"dirty":$dirty,"updateAvailable":$update_available,"state":$(json_escape "$state"),"message":$(json_escape "$message")},"plan":{"allowed":$plan_allowed,"commands":["systemctl start hivewright-update.service"],"message":$(json_escape "$plan_message")}}
JSON
}

apply_update() {
  ensure_root
  ensure_paths
  configure_root_git
  local log_file
  log_file="$LOG_DIR/hivewright-update-$(date +%Y%m%d-%H%M%S).log"

  {
    echo "HiveWright privileged operational updater"
    echo "started=$(date -Is)"
    echo "install_dir=$INSTALL_DIR"
    echo "runtime_root=$RUNTIME_ROOT"
    echo "service_user=$SERVICE_USER"
    echo

    cd "$INSTALL_DIR"
    echo "== preflight =="
    ensure_canonical_remote
    [ "$(git rev-parse --show-toplevel)" = "$INSTALL_DIR" ]
    echo "head_before=$(git rev-parse HEAD)"
    echo "branch=$(git branch --show-current)"
    echo "dirty_count=$(repo_dirty_count)"
    if [ "$(repo_dirty_count)" != "0" ]; then
      echo "Refusing update: operational checkout is dirty." >&2
      git status --short >&2
      exit 10
    fi

    echo
    echo "== fetch/pull =="
    git fetch --tags --prune origin
    before="$(git rev-parse HEAD)"
    upstream="$(git rev-parse '@{u}')"
    echo "upstream=$upstream"
    if [ "$before" = "$upstream" ]; then
      echo "Already current; continuing verification and relock."
    elif git merge-base --is-ancestor "$before" "$upstream"; then
      git pull --ff-only
    elif git merge-base --is-ancestor "$upstream" "$before"; then
      echo "Refusing update: local checkout is ahead of upstream. Publish or reset local commits first." >&2
      exit 11
    else
      echo "Refusing update: local checkout and upstream have diverged. Reconcile local commits before automatic update." >&2
      exit 12
    fi

    echo
    echo "== dependencies/build/migrations =="
    export HIVEWRIGHT_RUNTIME_ROOT="$RUNTIME_ROOT"
    export HIVEWRIGHT_ENV_FILE="$ENV_FILE"
    npm install
    npm run db:migrate:app
    npm run build:runtime
    npm run build:dispatcher
    node --check dispatcher-bundle.js

    echo
    echo "== relock =="
    lock_repo
    stat -c '%U:%G %A %n' "$INSTALL_DIR"

    echo
    echo "== restart services =="
    runuser -u "$SERVICE_USER" -- env XDG_RUNTIME_DIR="/run/user/$(id -u "$SERVICE_USER")" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u "$SERVICE_USER")/bus" systemctl --user restart hivewright-dashboard.service hivewright-dispatcher.service

    echo
    echo "== verify =="
    runuser -u "$SERVICE_USER" -- env XDG_RUNTIME_DIR="/run/user/$(id -u "$SERVICE_USER")" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u "$SERVICE_USER")/bus" systemctl --user is-active hivewright-dashboard.service hivewright-dispatcher.service
    dashboard_pid="$(runuser -u "$SERVICE_USER" -- env XDG_RUNTIME_DIR="/run/user/$(id -u "$SERVICE_USER")" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u "$SERVICE_USER")/bus" systemctl --user show hivewright-dashboard.service -p MainPID --value | tail -n 1)"
    dispatcher_pid="$(runuser -u "$SERVICE_USER" -- env XDG_RUNTIME_DIR="/run/user/$(id -u "$SERVICE_USER")" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u "$SERVICE_USER")/bus" systemctl --user show hivewright-dispatcher.service -p MainPID --value | tail -n 1)"
    dashboard_cwd=""
    dispatcher_cwd=""
    for service_pid in "$dashboard_pid" "$dispatcher_pid"; do
      [ -z "$service_pid" ] && continue
      [ "$service_pid" = "0" ] && continue
      cwd="$(readlink "/proc/$service_pid/cwd" 2>/dev/null || true)"
      echo "pid=$service_pid cwd=$cwd"
      [ "$cwd" = "$INSTALL_DIR" ] || { echo "Service PID $service_pid is not running from $INSTALL_DIR" >&2; exit 30; }
      if [ "$service_pid" = "$dashboard_pid" ]; then
        dashboard_cwd="$cwd"
      elif [ "$service_pid" = "$dispatcher_pid" ]; then
        dispatcher_cwd="$cwd"
      fi
    done
    dashboard_health_json="$(curl -fsS "$DASHBOARD_URL/api/health" || true)"
    dashboard_build_hash="$(printf '%s' "$dashboard_health_json" | extract_health_build_hash)"
    [ -n "$dashboard_build_hash" ] || dashboard_build_hash="$(git rev-parse HEAD)"
    echo "dashboard_build_hash=$dashboard_build_hash"
    head_after="$(git rev-parse HEAD)"
    write_cutover_record "$(date -Is)" "$head_after" "$dashboard_build_hash" "$dashboard_pid" "$dashboard_cwd" "$dispatcher_pid" "$dispatcher_cwd"
    echo "cutover_file=$CUTOVER_FILE"
    echo "head_after=$head_after"
    echo "completed=$(date -Is)"
  } 2>&1 | tee "$log_file"

  chown "$SERVICE_USER:$SERVICE_USER" "$log_file" 2>/dev/null || true
  echo "Log: $log_file"
}

case "$MODE" in
  status-json) status_json ;;
  apply) apply_update ;;
  lock) ensure_root; ensure_paths; configure_root_git; ensure_canonical_remote; lock_repo ;;
  *) echo "Usage: $0 [status-json|apply|lock]" >&2; exit 2 ;;
esac
