import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const updaterScript = path.join(repoRoot, "scripts/hivewright-operational-update-root.sh");
type TestEnv = Record<string, string | undefined>;

type Fixture = {
  root: string;
  installDir: string;
  runtimeRoot: string;
  remoteDir: string;
  oldCommit: string;
  targetCommit: string;
  env: TestEnv;
  cleanup: () => void;
};

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeExecutable(file: string, content: string) {
  writeFileSync(file, content, "utf8");
  chmodSync(file, 0o755);
}

function makeMockBin(root: string) {
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });

  writeExecutable(path.join(bin, "npm"), `#!/usr/bin/env bash
set -euo pipefail
prefix="$PWD"
args=("$@")
if [ "\${args[0]:-}" = "--prefix" ]; then
  prefix="\${args[1]}"
  args=("\${args[@]:2}")
fi
cmd="\${args[*]}"
echo "mock_npm cwd=$PWD prefix=$prefix cmd=$cmd" >> "$HIVEWRIGHT_MOCK_LOG"
case "$cmd" in
  install)
    [ "\${HIVEWRIGHT_FAIL_PHASE:-}" = "dependency-install" ] && exit 41
    ;;
  "run build:runtime")
    [ "\${HIVEWRIGHT_FAIL_PHASE:-}" = "dashboard-build" ] && exit 42
    ;;
  "run build:dispatcher")
    [ "\${HIVEWRIGHT_FAIL_PHASE:-}" = "dispatcher-build" ] && exit 43
    ;;
  "run db:migrate:app")
    [ "\${HIVEWRIGHT_FAIL_PHASE:-}" = "database-migration" ] && exit 44
    ;;
esac
exit 0
`);

  writeExecutable(path.join(bin, "systemctl"), `#!/usr/bin/env bash
set -euo pipefail
echo "mock_systemctl $*" >> "$HIVEWRIGHT_MOCK_LOG"
if printf '%s\n' "$*" | grep -q 'restart'; then
  [ "\${HIVEWRIGHT_FAIL_PHASE:-}" = "service-restart" ] && exit 45
  exit 0
fi
if printf '%s\n' "$*" | grep -q 'is-active'; then
  echo active
  echo active
  exit 0
fi
if printf '%s\n' "$*" | grep -q 'MainPID'; then
  echo 0
  exit 0
fi
exit 0
`);

  writeExecutable(path.join(bin, "curl"), `#!/usr/bin/env bash
set -euo pipefail
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$out" ] && printf '{"data":{"buildHash":"%s"}}' "$HIVEWRIGHT_EXPECTED_BUILD_HASH" > "$out"
printf '200'
`);

  return bin;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "hivewright-operational-update-"));
  const remoteDir = path.join(root, "remote.git");
  const seedDir = path.join(root, "seed");
  const installDir = path.join(root, "install");
  const runtimeRoot = path.join(root, "runtime");
  mkdirSync(seedDir, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });

  git(seedDir, ["init", "-b", "main"]);
  git(seedDir, ["config", "user.email", "test@example.invalid"]);
  git(seedDir, ["config", "user.name", "HiveWright Test"]);
  writeFileSync(path.join(seedDir, "package.json"), JSON.stringify({ version: "0.1.0" }), "utf8");
  writeFileSync(path.join(seedDir, "dispatcher-bundle.js"), "console.log('bundle');\n", "utf8");
  git(seedDir, ["add", "."]);
  git(seedDir, ["commit", "-m", "initial"]);
  const oldCommit = git(seedDir, ["rev-parse", "HEAD"]);
  git(seedDir, ["init", "--bare", remoteDir]);
  git(seedDir, ["remote", "add", "origin", remoteDir]);
  git(seedDir, ["push", "-u", "origin", "main"]);
  git(remoteDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  git(root, ["clone", remoteDir, installDir]);
  writeFileSync(path.join(seedDir, "package.json"), JSON.stringify({ version: "0.1.1" }), "utf8");
  git(seedDir, ["add", "package.json"]);
  git(seedDir, ["commit", "-m", "target"]);
  const targetCommit = git(seedDir, ["rev-parse", "HEAD"]);
  git(seedDir, ["push", "origin", "main"]);

  const bin = makeMockBin(root);
  const env: TestEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HIVEWRIGHT_OPERATIONAL_UPDATE_TESTING: "1",
    HIVEWRIGHT_SERVICE_USER: process.env.USER ?? "nobody",
    HIVEWRIGHT_LOCKED_INSTALL_DIR: installDir,
    HIVEWRIGHT_INSTALL_DIR: installDir,
    HIVEWRIGHT_RUNTIME_ROOT: runtimeRoot,
    HIVEWRIGHT_ENV_FILE: path.join(runtimeRoot, "config", ".env"),
    HIVEWRIGHT_CANONICAL_REMOTE_URL: remoteDir,
    HIVEWRIGHT_DASHBOARD_HEALTH_RETRY_COUNT: "1",
    HIVEWRIGHT_DASHBOARD_HEALTH_RETRY_DELAY_SECONDS: "0",
    HIVEWRIGHT_MOCK_LOG: path.join(root, "mock.log"),
    HIVEWRIGHT_EXPECTED_BUILD_HASH: targetCommit,
  };

  return {
    root,
    installDir,
    runtimeRoot,
    remoteDir,
    oldCommit,
    targetCommit,
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runUpdater(fixture: Fixture, mode: "apply" | "status-json", extraEnv: TestEnv = {}) {
  return spawnSync("bash", [updaterScript, mode], {
    cwd: repoRoot,
    env: { NODE_ENV: process.env.NODE_ENV ?? "test", ...fixture.env, ...extraEnv } as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
}

describe("privileged operational updater failure recovery", () => {
  it.each([
    ["dependency-install", "dependency-install", 41, false],
    ["dashboard-build", "dashboard-build", 42, false],
    ["dispatcher-build", "dispatcher-build", 43, false],
    ["database-migration", "database-migration", 44, true],
    ["service-restart", "service-restart", 45, true],
  ])("records and exposes failed %s phase without live services", (_name, failPhase, code, promoted) => {
    const fixture = makeFixture();
    try {
      const result = runUpdater(fixture, "apply", { HIVEWRIGHT_FAIL_PHASE: failPhase as string });
      expect(result.status).toBe(code);
      expect(result.stdout + result.stderr).toContain(`Update failed during phase '${failPhase}'`);
      expect(result.stdout + result.stderr).toContain("test_lock_repo=");

      const failurePath = path.join(fixture.runtimeRoot, "logs", "deployments", "latest-runtime-cutover-failure.json");
      expect(existsSync(failurePath)).toBe(true);
      const failure = JSON.parse(readFileSync(failurePath, "utf8"));
      expect(failure.phase).toBe(failPhase);
      expect(failure.targetCommit).toBe(fixture.targetCommit);
      expect(failure.checkoutCommit).toBe(promoted ? fixture.targetCommit : fixture.oldCommit);

      const installHead = git(fixture.installDir, ["rev-parse", "HEAD"]);
      expect(installHead).toBe(promoted ? fixture.targetCommit : fixture.oldCommit);

      const status = runUpdater(fixture, "status-json");
      expect(status.status).toBe(0);
      const parsed = JSON.parse(status.stdout);
      expect(parsed.status.state).toBe("repair-required");
      expect(parsed.status.failedUpdatePhase).toBe(failPhase);
      expect(parsed.plan.allowed).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("does not report current when checkout and upstream match but cutover build evidence is stale", () => {
    const fixture = makeFixture();
    try {
      git(fixture.installDir, ["fetch", "origin"]);
      git(fixture.installDir, ["merge", "--ff-only", fixture.targetCommit]);
      const deployDir = path.join(fixture.runtimeRoot, "logs", "deployments");
      mkdirSync(deployDir, { recursive: true });
      writeFileSync(path.join(deployDir, "latest-runtime-cutover.json"), JSON.stringify({
        deployedCommit: fixture.oldCommit,
        buildHash: fixture.oldCommit,
      }), "utf8");

      const status = runUpdater(fixture, "status-json");
      expect(status.status).toBe(0);
      const parsed = JSON.parse(status.stdout);
      expect(parsed.status.currentCommit).toBe(fixture.targetCommit);
      expect(parsed.status.upstreamCommit).toBe(fixture.targetCommit);
      expect(parsed.status.latestDeployedCommit).toBe(fixture.oldCommit);
      expect(parsed.status.state).toBe("repair-required");
      expect(parsed.status.updateAvailable).toBe(true);
      expect(parsed.plan.allowed).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});
