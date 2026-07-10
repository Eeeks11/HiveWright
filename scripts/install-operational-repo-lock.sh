#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo from the locked operational install: sudo ./scripts/install-operational-repo-lock.sh" >&2
  exit 77
fi

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
INSTALL_DIR="${HIVEWRIGHT_INSTALL_DIR:-$SERVICE_HOME/apps/HiveWright}"
RUNTIME_ROOT="${HIVEWRIGHT_RUNTIME_ROOT:-$SERVICE_HOME/.hivewright}"
UPDATER_SRC="$INSTALL_DIR/scripts/hivewright-operational-update-root.sh"
UPDATER_DST="/usr/local/sbin/hivewright-operational-update"
SERVICE_PATH="/etc/systemd/system/hivewright-update.service"
SUDOERS_PATH="/etc/sudoers.d/hivewright-update"

[ -f "$UPDATER_SRC" ] || { echo "Missing updater source: $UPDATER_SRC" >&2; exit 2; }
[ -d "$INSTALL_DIR/.git" ] || { echo "Missing operational git checkout: $INSTALL_DIR" >&2; exit 3; }
[ -d "$RUNTIME_ROOT" ] || mkdir -p "$RUNTIME_ROOT"

cat > "$UPDATER_DST" <<WRAPPER
#!/usr/bin/env bash
set -euo pipefail
export HIVEWRIGHT_LOCKED_INSTALL_DIR="\${HIVEWRIGHT_LOCKED_INSTALL_DIR:-$INSTALL_DIR}"
export HIVEWRIGHT_INSTALL_DIR="\${HIVEWRIGHT_INSTALL_DIR:-$INSTALL_DIR}"
exec "\$HIVEWRIGHT_INSTALL_DIR/scripts/hivewright-operational-update-root.sh" "\$@"
WRAPPER
chown root:root "$UPDATER_DST"
chmod 0755 "$UPDATER_DST"

cat > "$SERVICE_PATH" <<UNIT
[Unit]
Description=HiveWright privileged operational update
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=root
Group=root
Environment=HIVEWRIGHT_INSTALL_DIR=$INSTALL_DIR
Environment=HIVEWRIGHT_LOCKED_INSTALL_DIR=$INSTALL_DIR
Environment=HIVEWRIGHT_RUNTIME_ROOT=$RUNTIME_ROOT
Environment=HIVEWRIGHT_ENV_FILE=$RUNTIME_ROOT/config/.env
Environment=HIVEWRIGHT_SERVICE_USER=$SERVICE_USER
ExecStart=/usr/local/sbin/hivewright-operational-update apply
TimeoutStartSec=1800
UNIT
chmod 0644 "$SERVICE_PATH"

cat > "$SUDOERS_PATH" <<SUDOERS
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/systemctl --no-block start hivewright-update.service
$SERVICE_USER ALL=(root) NOPASSWD: /usr/local/sbin/hivewright-operational-update status-json
SUDOERS
chmod 0440 "$SUDOERS_PATH"
visudo -cf "$SUDOERS_PATH"

systemctl daemon-reload

git config --global --add safe.directory "$INSTALL_DIR" 2>/dev/null || true

# Lock the operational checkout: readable/executable by services, writable only by root/updater.
chown -R root:root "$INSTALL_DIR"
chmod -R u+rwX,go+rX,go-w "$INSTALL_DIR"

mkdir -p "$RUNTIME_ROOT/logs/updates"
chown -R "$SERVICE_USER:$SERVICE_USER" "$RUNTIME_ROOT/logs"

printf 'Installed updater: '; stat -c '%U:%G %A %n' "$UPDATER_DST"
printf 'Installed service: '; stat -c '%U:%G %A %n' "$SERVICE_PATH"
printf 'Installed sudoers: '; stat -c '%U:%G %A %n' "$SUDOERS_PATH"
printf 'Locked repo: '; stat -c '%U:%G %A %n' "$INSTALL_DIR"

sudo -u "$SERVICE_USER" sudo -n /usr/local/sbin/hivewright-operational-update status-json >/dev/null

echo "HiveWright operational repo lock installed."
