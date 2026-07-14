#!/usr/bin/env bash
set -eo pipefail

APP_DIR="${HIVEWRIGHT_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
cd "$APP_DIR"

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

set -a
RUNTIME_ROOT="$(resolve_runtime_root)"
ENV_FILE="${HIVEWRIGHT_ENV_FILE:-$RUNTIME_ROOT/config/.env}"
[ -f "$ENV_FILE" ] && source "$ENV_FILE"
# Load OpenClaw secrets so subprocess agents inherit GITHUB_TOKEN, XAI_API_KEY,
# GEMINI_API_KEY, OPENAI_API_KEY — without these, openclaw config-load fails on
# missing env-var substitution and every agent crashes at boot.
SECRETS_FILE="${HIVEWRIGHT_SECRETS_FILE:-$RUNTIME_ROOT/secrets.env}"
[ -f "$SECRETS_FILE" ] && source "$SECRETS_FILE"
unset HIVEWRIGHT_OWNER_SETUP_TOKEN
set +a

echo "[start-dispatcher] applying database migrations"
if ! npm run db:migrate:app; then
  echo "[start-dispatcher] migration gate failed; refusing to start dispatcher" >&2
  exit 1
fi
echo "[start-dispatcher] migrations complete; starting dispatcher bundle"

exec node dispatcher-bundle.js "$@"
