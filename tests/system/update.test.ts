import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildUpdatePlan,
  parseUpdateStatus,
  type GitUpdateSnapshot,
} from "@/system/update";
import { resolveUpdateLogDirectory } from "@/system/update-logs";

describe("HiveWright update system", () => {
  it("reports the app version from package metadata", () => {
    const status = parseUpdateStatus({
      packageVersion: "1.2.3",
      currentCommit: "abc1234",
      upstreamCommit: "def5678",
      remoteUrl: "https://github.com/example/hivewright-v2.git",
      branch: "main",
      dirty: false,
      relation: "behind",
    });

    expect(status.currentVersion).toBe("1.2.3");
    expect(status.updateAvailable).toBe(true);
    expect(status.state).toBe("update-available");
  });

  it("marks a clean checkout current when local and upstream commits match", () => {
    const status = parseUpdateStatus({
      packageVersion: "1.2.3",
      currentCommit: "abc1234",
      upstreamCommit: "abc1234",
      remoteUrl: "https://github.com/example/hivewright-v2.git",
      branch: "main",
      dirty: false,
      relation: "current",
    });

    expect(status.updateAvailable).toBe(false);
    expect(status.state).toBe("current");
  });

  it("blocks automatic update when the install has local changes", () => {
    const snapshot: GitUpdateSnapshot = {
      packageVersion: "1.2.3",
      currentCommit: "abc1234",
      upstreamCommit: "def5678",
      remoteUrl: "https://github.com/example/hivewright-v2.git",
      branch: "main",
      dirty: true,
    };

    const status = parseUpdateStatus(snapshot);
    const plan = buildUpdatePlan(status, { apply: true });

    expect(status.state).toBe("blocked-dirty-worktree");
    expect(plan.allowed).toBe(false);
    expect(plan.commands).toEqual([]);
  });

  it("blocks automatic update when the install is ahead of upstream", () => {
    const status = parseUpdateStatus({
      packageVersion: "1.2.3",
      currentCommit: "def5678",
      upstreamCommit: "abc1234",
      remoteUrl: "https://github.com/example/hivewright-v2.git",
      branch: "main",
      dirty: false,
      relation: "ahead",
    });
    const plan = buildUpdatePlan(status, { apply: true });

    expect(status.state).toBe("blocked-local-ahead");
    expect(status.updateAvailable).toBe(false);
    expect(plan.allowed).toBe(false);
  });

  it("blocks automatic update when the install has diverged from upstream", () => {
    const status = parseUpdateStatus({
      packageVersion: "1.2.3",
      currentCommit: "abc1234",
      upstreamCommit: "def5678",
      remoteUrl: "https://github.com/example/hivewright-v2.git",
      branch: "main",
      dirty: false,
      relation: "diverged",
    });
    const plan = buildUpdatePlan(status, { apply: true });

    expect(status.state).toBe("blocked-diverged");
    expect(status.updateAvailable).toBe(true);
    expect(plan.allowed).toBe(false);
  });

  it("builds a normal self-hosted update command plan", () => {
    const status = parseUpdateStatus({
      packageVersion: "1.2.3",
      currentCommit: "abc1234",
      upstreamCommit: "def5678",
      remoteUrl: "https://github.com/example/hivewright-v2.git",
      branch: "main",
      dirty: false,
      relation: "behind",
    });

    const plan = buildUpdatePlan(status, { apply: true, restart: true });

    expect(plan.allowed).toBe(true);
    expect(plan.commands).toEqual([
      "git pull --ff-only",
      "npm install",
      "npm run db:migrate:app",
      "npm run build:runtime",
      "npm run build:dispatcher",
      "systemctl --user restart hivewright-dashboard hivewright-dispatcher",
    ]);
  });

  it("loads runtime env when the privileged updater builds the dashboard", () => {
    const script = readFileSync(
      path.resolve(__dirname, "../../scripts/hivewright-operational-update-root.sh"),
      "utf8",
    );

    expect(script).toContain("npm run build:runtime");
    expect(script).not.toMatch(/^\s*npm run build\s*$/m);
  });

  it("writes a canonical runtime cutover record after privileged updates", () => {
    const script = readFileSync(
      path.resolve(__dirname, "../../scripts/hivewright-operational-update-root.sh"),
      "utf8",
    );

    expect(script).toContain("latest-runtime-cutover.json");
    expect(script).toContain("\"runtimeMode\":\"locked-install\"");
    expect(script).toContain('DASHBOARD_URL="${HIVEWRIGHT_DASHBOARD_HEALTH_URL:-http://127.0.0.1:3002}"');
    expect(script).toContain("verify_dashboard_health()");
    expect(script).toContain('http_code="$(curl -sS -o "$tmp_file" -w \'%{http_code}\' "$health_url" || printf \'000\')"');
    expect(script).toContain('echo "dashboard_http=$DASHBOARD_HTTP_CODE"');
    expect(script).toContain('Dashboard build hash does not match operational checkout head');
    expect(script).not.toContain('[ -n "$dashboard_build_hash" ] || dashboard_build_hash="$(git rev-parse HEAD)"');
  });

  it("enforces the canonical operational remote and main branch in the privileged updater", () => {
    const script = readFileSync(
      path.resolve(__dirname, "../../scripts/hivewright-operational-update-root.sh"),
      "utf8",
    );

    expect(script).toContain('CANONICAL_REMOTE_URL="${HIVEWRIGHT_CANONICAL_REMOTE_URL:-https://github.com/Eeeks11/HiveWright.git}"');
    expect(script).toContain("ensure_canonical_remote()");
    expect(script).toContain("Operational install origin remote is not the canonical GitHub remote; automatic updates are blocked until the remote is restored.");
    expect(script).toContain('state":"blocked-remote-misconfigured"');
    expect(script).toContain("expectedRemoteUrl");
    expect(script).toContain("ensure_canonical_remote\n");
  });

  it("uses canonical preflight checks for apply/lock and exposes the current service start command", () => {
    const script = readFileSync(
      path.resolve(__dirname, "../../scripts/hivewright-operational-update-root.sh"),
      "utf8",
    );

    expect(script).toContain('commands":["systemctl start hivewright-update.service"]');
    expect(script).toContain("ensure_canonical_remote\n    [ \"$(git rev-parse --show-toplevel)\" = \"$INSTALL_DIR\" ]");
    expect(script).toContain('lock) ensure_root; ensure_paths; configure_root_git; ensure_canonical_remote; lock_repo ;;');
  });

  it("installs the privileged updater as a wrapper around the locked operational checkout", () => {
    const script = readFileSync(
      path.resolve(__dirname, "../../scripts/install-operational-repo-lock.sh"),
      "utf8",
    );

    expect(script).not.toContain('install -o root -g root -m 0755 "$UPDATER_SRC" "$UPDATER_DST"');
    expect(script).toContain("cat > \"$UPDATER_DST\" <<'WRAPPER'");
    expect(script).toContain('exec /home/trent/apps/HiveWright/scripts/hivewright-operational-update-root.sh "$@"');
    expect(script).toContain('sudo -u "$SERVICE_USER" sudo -n /usr/local/sbin/hivewright-operational-update status-json >/dev/null');
  });

  it("places dashboard update logs under the external runtime root", () => {
    const dir = resolveUpdateLogDirectory({
      HIVEWRIGHT_RUNTIME_ROOT: "/var/lib/hivewright-runtime",
      HOME: "/home/operator",
    });

    expect(dir).toBe("/var/lib/hivewright-runtime/logs/updates");
  });

  it("falls back dashboard update logs to HOME runtime storage", () => {
    const dir = resolveUpdateLogDirectory({ HOME: "/home/operator" });

    expect(dir).toBe("/home/operator/.hivewright/logs/updates");
  });
});
