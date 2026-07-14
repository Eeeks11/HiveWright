#!/usr/bin/env bash
set -eo pipefail

resolve_runtime_root() {
  if [ -n "${HIVEWRIGHT_RUNTIME_ROOT:-}" ]; then
    printf '%s\n' "$HIVEWRIGHT_RUNTIME_ROOT"
    return
  fi

  if [ -n "${HOME:-}" ] && [ -d "$HOME/.hivewright" ]; then
    printf '%s\n' "$HOME/.hivewright"
    return
  fi

  local user_home=""
  user_home="$(node -p "require('os').userInfo().homedir" 2>/dev/null || true)"
  if [ -n "$user_home" ]; then
    printf '%s\n' "$user_home/.hivewright"
    return
  fi

  printf '%s\n' "${HOME:-$PWD}/.hivewright"
}

RUNTIME_ROOT="$(resolve_runtime_root)"
ENV_FILE="${HIVEWRIGHT_ENV_FILE:-$RUNTIME_ROOT/config/.env}"
SECRETS_FILE="${HIVEWRIGHT_SECRETS_FILE:-$RUNTIME_ROOT/secrets.env}"

set -a
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi
if [ -f "$SECRETS_FILE" ]; then
  # shellcheck disable=SC1090
  source "$SECRETS_FILE"
fi
# The raw owner setup token is read from the file by the provisioning command
# only. Never propagate it into dashboard, dispatcher, build, or test processes.
unset HIVEWRIGHT_OWNER_SETUP_TOKEN
set +a

export PATH="$PWD/node_modules/.bin:$PATH"

if [ "${1:-}" = "tsx" ] && ! command -v tsx >/dev/null 2>&1; then
  set -- npx --yes "$@"
fi

if command -v tsx >/dev/null 2>&1; then
  exec tsx scripts/with-managed-postgres.ts "$@"
fi

exec npx --yes tsx scripts/with-managed-postgres.ts "$@"
