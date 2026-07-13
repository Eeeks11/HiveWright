#!/usr/bin/env bash
set -euo pipefail

resolve_service_user() {
  if [ -n "${HIVEWRIGHT_SERVICE_USER:-}" ]; then
    printf '%s\n' "$HIVEWRIGHT_SERVICE_USER"
  elif [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    printf '%s\n' "$SUDO_USER"
  else
    logname 2>/dev/null || id -un
  fi
}

SERVICE_USER="$(resolve_service_user)"
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
SERVICE_HOME="${SERVICE_HOME:-$HOME}"
LOCKED_INSTALL_DIR="${HIVEWRIGHT_LOCKED_INSTALL_DIR:-$SERVICE_HOME/apps/HiveWright}"
INSTALL_DIR="${HIVEWRIGHT_INSTALL_DIR:-$LOCKED_INSTALL_DIR}"
RUNTIME_ROOT="${HIVEWRIGHT_RUNTIME_ROOT:-$SERVICE_HOME/.hivewright}"
ENV_FILE="${HIVEWRIGHT_ENV_FILE:-$RUNTIME_ROOT/config/.env}"
LOG_DIR="$RUNTIME_ROOT/logs/updates"
DEPLOYMENT_DIR="$RUNTIME_ROOT/logs/deployments"
CUTOVER_FILE="$DEPLOYMENT_DIR/latest-runtime-cutover.json"
CUTOVER_FAILURE_FILE="$DEPLOYMENT_DIR/latest-runtime-cutover-failure.json"
STAGING_DIR="$RUNTIME_ROOT/update-staging"
DASHBOARD_URL="${HIVEWRIGHT_DASHBOARD_HEALTH_URL:-http://127.0.0.1:3002}"
HEALTH_RETRY_COUNT="${HIVEWRIGHT_DASHBOARD_HEALTH_RETRY_COUNT:-15}"
HEALTH_RETRY_DELAY_SECONDS="${HIVEWRIGHT_DASHBOARD_HEALTH_RETRY_DELAY_SECONDS:-2}"
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

verify_dashboard_health() {
  local health_url="${DASHBOARD_URL%/}/api/health"
  local attempt http_code tmp_file build_hash
  tmp_file="$(mktemp)"
  trap 'rm -f "$tmp_file"' RETURN

  for attempt in $(seq 1 "$HEALTH_RETRY_COUNT"); do
    : > "$tmp_file"
    http_code="$(curl -sS -o "$tmp_file" -w '%{http_code}' "$health_url" || printf '000')"
    build_hash="$(extract_health_build_hash < "$tmp_file")"
    echo "dashboard_health_attempt=$attempt/$HEALTH_RETRY_COUNT dashboard_http=$http_code"
    if [ "$http_code" = "200" ] && [ -n "$build_hash" ]; then
      DASHBOARD_HTTP_CODE="$http_code"
      DASHBOARD_BUILD_HASH="$build_hash"
      return 0
    fi
    [ "$attempt" -lt "$HEALTH_RETRY_COUNT" ] && sleep "$HEALTH_RETRY_DELAY_SECONDS"
  done

  echo "Dashboard health verification failed after $HEALTH_RETRY_COUNT attempts: $health_url" >&2
  if [ -s "$tmp_file" ]; then
    echo "dashboard_health_body=$(tr '\n' ' ' < "$tmp_file")" >&2
  fi
  return 31
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
  if [ "${HIVEWRIGHT_OPERATIONAL_UPDATE_TESTING:-}" = "1" ]; then
    return 0
  fi
  if [ "$(id -u)" -ne 0 ]; then
    echo "hivewright-operational-update must run as root" >&2
    exit 77
  fi
}

ensure_paths() {
  [ "$INSTALL_DIR" = "$LOCKED_INSTALL_DIR" ] || { echo "Refusing unexpected install path: $INSTALL_DIR" >&2; exit 20; }
  [ -d "$INSTALL_DIR/.git" ] || { echo "Install dir is not a git checkout: $INSTALL_DIR" >&2; exit 21; }
  mkdir -p "$LOG_DIR" "$DEPLOYMENT_DIR"
  if [ "${HIVEWRIGHT_OPERATIONAL_UPDATE_TESTING:-}" != "1" ]; then
    chown -R "$SERVICE_USER:$SERVICE_USER" "$RUNTIME_ROOT/logs" 2>/dev/null || true
  fi
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
  if [ "${HIVEWRIGHT_OPERATIONAL_UPDATE_TESTING:-}" = "1" ]; then
    echo "test_lock_repo=$INSTALL_DIR"
    return 0
  fi
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

  local version branch current upstream remote dirty state update_available message relation plan_allowed plan_message latest_deployed latest_build failed_phase failed_target
  version="$(node -e "console.log(require('$INSTALL_DIR/package.json').version || '0.0.0')")"
  branch="$(git -C "$INSTALL_DIR" branch --show-current 2>/dev/null || true)"
  current="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
  upstream="$(git -C "$INSTALL_DIR" rev-parse '@{u}' 2>/dev/null || true)"
  remote="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null | sed -E 's#(https?://)[^/@:]+:[^/@]+@#\1#' || true)"
  dirty="false"
  [ "$(repo_dirty_count)" = "0" ] || dirty="true"
  latest_deployed="$(read_json_field "$CUTOVER_FILE" deployedCommit)"
  latest_build="$(read_json_field "$CUTOVER_FILE" buildHash)"
  failed_phase="$(read_json_field "$CUTOVER_FAILURE_FILE" phase)"
  failed_target="$(read_json_field "$CUTOVER_FAILURE_FILE" targetCommit)"
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
  elif [ -n "$failed_phase" ]; then
    state="repair-required"; update_available="true"; message="The last privileged update failed during phase '$failed_phase'. Run the operational updater to rebuild, relock, and verify the locked install."
  elif [ "$relation" = "diverged" ]; then
    state="blocked-diverged"; update_available="true"; message="This install and the configured Git remote have diverged. Automatic fast-forward update is blocked until the local commits are reconciled."
  elif [ "$relation" = "ahead" ]; then
    state="blocked-local-ahead"; update_available="false"; message="This install has local commits that are not on the configured Git remote. Publish or reset them before using automatic updates."
  elif [ "$relation" = "behind" ]; then
    state="update-available"; update_available="true"; message="A newer HiveWright commit is available from the configured Git remote."
  elif [ -z "$latest_deployed" ] || [ "$latest_deployed" != "$current" ] || [ -z "$latest_build" ] || [ "$latest_build" != "$current" ]; then
    state="repair-required"; update_available="true"; message="The locked checkout matches upstream, but the latest runtime cutover/build evidence does not match the checkout HEAD. Run the operational updater to repair and verify the deployed build."
  else
    state="current"; update_available="false"; message="HiveWright is current with the configured Git remote."
  fi

  plan_allowed="false"
  plan_message="No privileged update is currently available."
  if [ "$state" = "update-available" ] || [ "$state" = "repair-required" ]; then
    plan_allowed="true"
    plan_message="Update can be applied by the privileged operational updater."
  elif [ "$state" = "blocked-diverged" ] || [ "$state" = "blocked-local-ahead" ] || [ "$state" = "blocked-dirty-worktree" ]; then
    plan_message="$message"
  fi

  cat <<JSON
{"status":{"currentVersion":$(json_escape "$version"),"currentCommit":$(json_escape "$current"),"upstreamCommit":$(json_escape "$upstream"),"remoteUrl":$(json_escape "$remote"),"branch":$(json_escape "$branch"),"dirty":$dirty,"updateAvailable":$update_available,"state":$(json_escape "$state"),"message":$(json_escape "$message"),"latestDeployedCommit":$(json_or_null "$latest_deployed"),"latestBuildHash":$(json_or_null "$latest_build"),"failedUpdatePhase":$(json_or_null "$failed_phase"),"failedUpdateTargetCommit":$(json_or_null "$failed_target")},"plan":{"allowed":$plan_allowed,"commands":["systemctl start hivewright-update.service"],"message":$(json_escape "$plan_message")}}
JSON
}

read_json_field() {
  local file="$1"
  local field="$2"
  [ -s "$file" ] || return 0
  node -e 'const fs=require("fs"); const file=process.argv[1]; const field=process.argv[2]; try { const data=JSON.parse(fs.readFileSync(file,"utf8")); const value=field.split(".").reduce((acc,key)=>acc && Object.prototype.hasOwnProperty.call(acc,key) ? acc[key] : undefined, data); if (value !== undefined && value !== null) process.stdout.write(String(value)); } catch {}' "$file" "$field"
}

write_failure_record() {
  local recorded_at="$1"
  local phase="$2"
  local exit_code="$3"
  local target_commit="$4"
  local checkout_commit="$5"
  local deployed_commit="$6"
  local build_hash="$7"
  local log_file_path="$8"

  cat > "$CUTOVER_FAILURE_FILE" <<JSON
{"recordedAt":$(json_escape "$recorded_at"),"runtimeMode":"locked-install","status":"failed","phase":$(json_escape "$phase"),"exitCode":$exit_code,"installDir":$(json_escape "$INSTALL_DIR"),"runtimeRoot":$(json_escape "$RUNTIME_ROOT"),"targetCommit":$(json_or_null "$target_commit"),"checkoutCommit":$(json_or_null "$checkout_commit"),"latestDeployedCommit":$(json_or_null "$deployed_commit"),"latestBuildHash":$(json_or_null "$build_hash"),"logFile":$(json_or_null "$log_file_path")}
JSON
  if [ "${HIVEWRIGHT_OPERATIONAL_UPDATE_TESTING:-}" != "1" ]; then
    chown "$SERVICE_USER:$SERVICE_USER" "$CUTOVER_FAILURE_FILE" 2>/dev/null || true
  fi
}

clear_failure_record() {
  rm -f "$CUTOVER_FAILURE_FILE"
}

run_as_service_user_env() {
  if [ "${HIVEWRIGHT_OPERATIONAL_UPDATE_TESTING:-}" = "1" ]; then
    "$@"
  else
    runuser -u "$SERVICE_USER" -- env XDG_RUNTIME_DIR="/run/user/$(id -u "$SERVICE_USER")" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u "$SERVICE_USER")/bus" "$@"
  fi
}

prepare_candidate_checkout() {
  local target_commit="$1"
  local candidate_dir="$2"
  rm -rf "$candidate_dir"
  mkdir -p "$STAGING_DIR"
  git clone "$CANONICAL_REMOTE_URL" "$candidate_dir"
  git -C "$candidate_dir" fetch --tags --prune origin
  git -C "$candidate_dir" checkout --detach "$target_commit"
  [ "$(git -C "$candidate_dir" rev-parse HEAD)" = "$target_commit" ]
}

sync_candidate_to_install() {
  local candidate_dir="$1"
  rsync -a --delete \
    --exclude='.git/' \
    --exclude='.next/cache/' \
    --exclude='node_modules/.cache/' \
    "$candidate_dir"/ "$INSTALL_DIR"/
}

apply_update_body() {
  set -eE
  local log_file="$1"
  local update_phase="preflight"
  local before=""
  local upstream=""
  local candidate_dir=""
  local dashboard_pid=""
  local dispatcher_pid=""
  local dashboard_cwd=""
  local dispatcher_cwd=""
  local head_after=""
  local cwd=""

  on_apply_failure() {
    local exit_code="$?"
    local checkout_commit deployed_commit build_hash
    checkout_commit="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
    deployed_commit="$(read_json_field "$CUTOVER_FILE" deployedCommit)"
    build_hash="$(read_json_field "$CUTOVER_FILE" buildHash)"
    echo "Update failed during phase '$update_phase' with exit code $exit_code" >&2
    echo "== failure relock =="
    lock_repo || true
    write_failure_record "$(date -Is)" "$update_phase" "$exit_code" "$upstream" "$checkout_commit" "$deployed_commit" "$build_hash" "$log_file" || true
    [ -n "$candidate_dir" ] && rm -rf "$candidate_dir"
    exit "$exit_code"
  }
  trap on_apply_failure ERR

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
  echo "== fetch/resolve target =="
  update_phase="fetch"
  git fetch --tags --prune origin
  before="$(git rev-parse HEAD)"
  upstream="$(git rev-parse '@{u}')"
  echo "upstream=$upstream"
  if [ "$before" = "$upstream" ]; then
    echo "Already current; continuing verification and relock."
  elif git merge-base --is-ancestor "$before" "$upstream"; then
    echo "fast_forward_target=$upstream"
  elif git merge-base --is-ancestor "$upstream" "$before"; then
    echo "Refusing update: local checkout is ahead of upstream. Publish or reset local commits first." >&2
    exit 11
  else
    echo "Refusing update: local checkout and upstream have diverged. Reconcile local commits before automatic update." >&2
    exit 12
  fi

  echo
  echo "== candidate checkout =="
  update_phase="candidate-checkout"
  candidate_dir="$STAGING_DIR/candidate-$upstream"
  prepare_candidate_checkout "$upstream" "$candidate_dir"
  echo "candidate_dir=$candidate_dir"
  echo "candidate_head=$(git -C "$candidate_dir" rev-parse HEAD)"

  echo
  echo "== candidate dependencies/build =="
  export HIVEWRIGHT_RUNTIME_ROOT="$RUNTIME_ROOT"
  export HIVEWRIGHT_ENV_FILE="$ENV_FILE"
  update_phase="dependency-install"
  npm --prefix "$candidate_dir" install
  update_phase="dashboard-build"
  npm --prefix "$candidate_dir" run build:runtime
  update_phase="dispatcher-build"
  npm --prefix "$candidate_dir" run build:dispatcher
  node --check "$candidate_dir/dispatcher-bundle.js"

  echo
  echo "== promote candidate =="
  update_phase="promote-checkout"
  if [ "$before" != "$upstream" ]; then
    git merge --ff-only "$upstream"
  fi
  sync_candidate_to_install "$candidate_dir"
  [ "$(git rev-parse HEAD)" = "$upstream" ]
  [ "$(repo_dirty_count)" = "0" ] || { echo "Promotion left operational checkout dirty." >&2; git status --short >&2; exit 33; }

  echo
  echo "== database migrations =="
  update_phase="database-migration"
  npm run db:migrate:app

  echo
  echo "== relock =="
  update_phase="relock"
  lock_repo
  stat -c '%U:%G %A %n' "$INSTALL_DIR"

  echo
  echo "== restart services =="
  update_phase="service-restart"
  run_as_service_user_env systemctl --user restart hivewright-dashboard.service hivewright-dispatcher.service

  echo
  echo "== verify =="
  update_phase="service-verify"
  run_as_service_user_env systemctl --user is-active hivewright-dashboard.service hivewright-dispatcher.service
  dashboard_pid="$(run_as_service_user_env systemctl --user show hivewright-dashboard.service -p MainPID --value | tail -n 1)"
  dispatcher_pid="$(run_as_service_user_env systemctl --user show hivewright-dispatcher.service -p MainPID --value | tail -n 1)"
  for service_pid in "$dashboard_pid" "$dispatcher_pid"; do
    [ -z "$service_pid" ] && continue
    [ "$service_pid" = "0" ] && continue
    cwd="$(readlink "/proc/$service_pid/cwd" 2>/dev/null || true)"
    if [ "${HIVEWRIGHT_OPERATIONAL_UPDATE_TESTING:-}" = "1" ] && [ -z "$cwd" ]; then
      cwd="$INSTALL_DIR"
    fi
    echo "pid=$service_pid cwd=$cwd"
    [ "$cwd" = "$INSTALL_DIR" ] || { echo "Service PID $service_pid is not running from $INSTALL_DIR" >&2; exit 30; }
    if [ "$service_pid" = "$dashboard_pid" ]; then
      dashboard_cwd="$cwd"
    elif [ "$service_pid" = "$dispatcher_pid" ]; then
      dispatcher_cwd="$cwd"
    fi
  done
  head_after="$(git rev-parse HEAD)"
  update_phase="dashboard-health"
  verify_dashboard_health
  echo "dashboard_http=$DASHBOARD_HTTP_CODE"
  echo "dashboard_build_hash=$DASHBOARD_BUILD_HASH"
  [ "$DASHBOARD_BUILD_HASH" = "$head_after" ] || {
    echo "Dashboard build hash does not match operational checkout head: expected $head_after, got $DASHBOARD_BUILD_HASH" >&2
    exit 32
  }
  write_cutover_record "$(date -Is)" "$head_after" "$DASHBOARD_BUILD_HASH" "$dashboard_pid" "$dashboard_cwd" "$dispatcher_pid" "$dispatcher_cwd"
  clear_failure_record
  rm -rf "$candidate_dir"
  echo "cutover_file=$CUTOVER_FILE"
  echo "head_after=$head_after"
  echo "completed=$(date -Is)"
  trap - ERR
}

apply_update() {
  ensure_root
  ensure_paths
  configure_root_git
  local log_file status
  log_file="$LOG_DIR/hivewright-update-$(date +%Y%m%d-%H%M%S).log"

  set +e
  apply_update_body "$log_file" 2>&1 | tee "$log_file"
  status=${PIPESTATUS[0]}
  set -e
  if [ "${HIVEWRIGHT_OPERATIONAL_UPDATE_TESTING:-}" != "1" ]; then
    chown "$SERVICE_USER:$SERVICE_USER" "$log_file" 2>/dev/null || true
  fi
  echo "Log: $log_file"
  return "$status"
}

case "$MODE" in
  status-json) status_json ;;
  apply) apply_update ;;
  lock) ensure_root; ensure_paths; configure_root_git; ensure_canonical_remote; lock_repo ;;
  *) echo "Usage: $0 [status-json|apply|lock]" >&2; exit 2 ;;
esac
