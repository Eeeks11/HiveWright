import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildUpdatePlan,
  parseUpdateStatus,
  type GitUpdateSnapshot,
} from "@/system/update";
import { resolveUpdateLogDirectory } from "@/system/update-logs";

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

const updateRuntimeMock = vi.hoisted(() => ({
  getUpdateStatus: vi.fn(),
  getUpdatePlan: vi.fn(),
}));

vi.mock("node:child_process", () => childProcessMock);
vi.mock("@/system/update-runtime", () => updateRuntimeMock);

async function importUpdateRouteWithOperationalUpdater() {
  vi.resetModules();
  const tmp = mkdtempSync(path.join(tmpdir(), "hivewright-update-route-"));
  const updater = path.join(tmp, "hivewright-operational-update");
  writeFileSync(updater, "#!/bin/sh\n", "utf8");

  const previous = {
    HIVEWRIGHT_OPERATIONAL_UPDATER: process.env.HIVEWRIGHT_OPERATIONAL_UPDATER,
    HIVEWRIGHT_SUDO: process.env.HIVEWRIGHT_SUDO,
    HIVEWRIGHT_RUNTIME_ROOT: process.env.HIVEWRIGHT_RUNTIME_ROOT,
    HIVEWRIGHT_INSTALL_DIR: process.env.HIVEWRIGHT_INSTALL_DIR,
  };
  process.env.HIVEWRIGHT_OPERATIONAL_UPDATER = updater;
  process.env.HIVEWRIGHT_SUDO = "/usr/bin/sudo";
  process.env.HIVEWRIGHT_RUNTIME_ROOT = tmp;
  process.env.HIVEWRIGHT_INSTALL_DIR = process.cwd();

  const route = await import("../../src/app/api/system/update/route");
  return {
    ...route,
    cleanup: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe("HiveWright update system", () => {
  beforeEach(() => {
    childProcessMock.execFile.mockReset();
    childProcessMock.spawn.mockReset();
    updateRuntimeMock.getUpdateStatus.mockReset();
    updateRuntimeMock.getUpdatePlan.mockReset();
  });
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

  it("suppresses locked-install FETCH_HEAD permission noise in the dashboard updater status", async () => {
    childProcessMock.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(Object.assign(new Error("Command failed: git fetch"), {
        stderr: "error: cannot open '.git/FETCH_HEAD': Permission denied\n",
        stdout: "",
      }));
      return {};
    });
    updateRuntimeMock.getUpdateStatus.mockResolvedValue({
      currentVersion: "1.2.3",
      currentCommit: "abc1234",
      upstreamCommit: "def5678",
      remoteUrl: "https://github.com/Eeeks11/HiveWright.git",
      branch: "main",
      dirty: false,
      updateAvailable: true,
      state: "update-available",
      message: "Update available.",
    });
    const route = await importUpdateRouteWithOperationalUpdater();

    try {
      const response = await route.GET();
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data.status.state).toBe("locked-install-status-suppressed");
      expect(body.data.status.updateAvailable).toBe(false);
      expect(body.data.status.message).toContain("suppressed an unprivileged Git fetch status check");
      expect(body.data.plan).toEqual({
        allowed: false,
        commands: [],
        message: expect.stringContaining("suppressed an unprivileged Git fetch status check"),
      });
      expect(updateRuntimeMock.getUpdateStatus).toHaveBeenCalledWith({ fetch: false });
      expect(childProcessMock.execFile).toHaveBeenCalledWith(
        "/usr/bin/sudo",
        ["-n", expect.stringContaining("hivewright-operational-update"), "status-json"],
        expect.objectContaining({ timeout: 60_000 }),
        expect.any(Function),
      );
    } finally {
      route.cleanup();
    }
  });

  it("keeps real operational updater status failures as 503 errors", async () => {
    childProcessMock.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(Object.assign(new Error("Command failed: status-json"), {
        stderr: "fatal: remote origin is not reachable\n",
        stdout: "diagnostic detail\n",
      }));
      return {};
    });
    const route = await importUpdateRouteWithOperationalUpdater();

    try {
      const response = await route.GET();
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.error).toContain("Operational updater status check failed");
      expect(body.error).toContain("fatal: remote origin is not reachable");
      expect(body.error).toContain("diagnostic detail");
      expect(body.error).not.toContain("locked-install-status-suppressed");
      expect(updateRuntimeMock.getUpdateStatus).not.toHaveBeenCalled();
    } finally {
      route.cleanup();
    }
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
