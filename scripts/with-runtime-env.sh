#!/usr/bin/env bash
set -eo pipefail

RUNTIME_ROOT="${HIVEWRIGHT_RUNTIME_ROOT:-$HOME/.hivewright}"
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

exec tsx scripts/with-managed-postgres.ts "$@"
