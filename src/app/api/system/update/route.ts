import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { jsonError, jsonOk } from "../../_lib/responses";
import { requireApiAuth, requireSystemOwner } from "../../_lib/auth";
import { getUpdatePlan, getUpdateStatus } from "@/system/update-runtime";
import { resolveUpdateLogDirectory } from "@/system/update-logs";
import { resolveHivewrightEnvFilePath, resolveHivewrightRuntimeRoot } from "@/runtime/paths";
import { evaluateRuntimeCutover, readRuntimeCutoverRecord } from "@/system/runtime-cutover";

const execFileAsync = promisify(execFile);
const OPERATIONAL_UPDATER = process.env.HIVEWRIGHT_OPERATIONAL_UPDATER ?? "/usr/local/sbin/hivewright-operational-update";
const SYSTEMCTL = process.env.HIVEWRIGHT_SYSTEMCTL ?? "/usr/bin/systemctl";
const SUDO = process.env.HIVEWRIGHT_SUDO ?? "/usr/bin/sudo";
const UPDATE_SERVICE = process.env.HIVEWRIGHT_UPDATE_SERVICE ?? "hivewright-update.service";
const INSTALL_DIR = process.env.HIVEWRIGHT_INSTALL_DIR ?? process.cwd();
const DASHBOARD_URL = process.env.HIVEWRIGHT_DASHBOARD_HEALTH_URL ?? "http://127.0.0.1:3002";
const LOCKED_INSTALL_FETCH_HEAD_MESSAGE =
  "Locked operational install suppressed an unprivileged Git fetch status check. Use the privileged HiveWright updater status/apply path; this is not a deployment failure.";

function updateLogPath() {
  const dir = resolveUpdateLogDirectory();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `update-${stamp}.log`);
}

type OperationalUpdaterPayload = {
  status: Awaited<ReturnType<typeof getUpdateStatus>>;
  plan: ReturnType<typeof getUpdatePlan>;
};

type ExecFailure = Error & { stderr?: string; stdout?: string; code?: number | string };

function formatExecFailure(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const failure = error as ExecFailure;
  const parts = [failure.message, failure.stderr, failure.stdout]
    .map((part) => part?.trim())
    .filter(Boolean);
  return Array.from(new Set(parts)).join("\n");
}

function isLockedInstallFetchHeadPermissionNoise(error: unknown) {
  const message = formatExecFailure(error);
  return /\.git\/FETCH_HEAD['\"]?: Permission denied/i.test(message)
    || /cannot open ['\"]?\.git\/FETCH_HEAD['\"]?: Permission denied/i.test(message);
}

async function buildSuppressedLockedInstallPayload(): Promise<OperationalUpdaterPayload> {
  const status = await getUpdateStatus({ fetch: false }).catch(async () => {
    const packageJson = JSON.parse(
      await fs.promises.readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { version?: string };
    return {
      currentVersion: packageJson.version ?? "0.0.0",
      currentCommit: null,
      upstreamCommit: null,
      remoteUrl: null,
      branch: null,
      dirty: false,
      updateAvailable: false,
      state: "locked-install-status-suppressed" as const,
      message: LOCKED_INSTALL_FETCH_HEAD_MESSAGE,
    };
  });

  return {
    status: {
      ...status,
      updateAvailable: false,
      state: "locked-install-status-suppressed",
      message: LOCKED_INSTALL_FETCH_HEAD_MESSAGE,
    },
    plan: {
      allowed: false,
      commands: [],
      message: LOCKED_INSTALL_FETCH_HEAD_MESSAGE,
    },
  };
}

async function readOperationalUpdaterStatus(): Promise<OperationalUpdaterPayload> {
  try {
    const { stdout } = await execFileAsync(SUDO, ["-n", OPERATIONAL_UPDATER, "status-json"], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });
    return JSON.parse(stdout) as OperationalUpdaterPayload;
  } catch (error) {
    if (isLockedInstallFetchHeadPermissionNoise(error)) {
      return buildSuppressedLockedInstallPayload();
    }
    throw error;
  }
}

async function loadCutoverStatus(status: { currentCommit: string | null }) {
  try {
    const repoRoot = fs.existsSync(path.join(INSTALL_DIR, "package.json")) ? INSTALL_DIR : process.cwd();
    const runtimeRoot = resolveHivewrightRuntimeRoot(process.env, repoRoot);
    const envFile = resolveHivewrightEnvFilePath(process.env, repoRoot);
    const read = await readRuntimeCutoverRecord({ env: process.env, repoRoot });
    return evaluateRuntimeCutover({
      ...read,
      expected: {
        runtimeMode: "locked-install",
        installDir: INSTALL_DIR,
        runtimeRoot,
        envFile,
        dashboardHealthUrl: DASHBOARD_URL,
        currentCommit: status.currentCommit,
        currentBuildHash: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.HIVEWRIGHT_BUILD_HASH ?? status.currentCommit,
      },
    });
  } catch (error) {
    return evaluateRuntimeCutover({
      path: path.join(resolveUpdateLogDirectory(), "..", "deployments", "latest-runtime-cutover.json"),
      record: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function GET() {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  if (fs.existsSync(OPERATIONAL_UPDATER)) {
    try {
      const payload = await readOperationalUpdaterStatus();
      return jsonOk({
        ...payload,
        cutover: await loadCutoverStatus(payload.status),
      });
    } catch (error) {
      return jsonError(`Operational updater status check failed: ${formatExecFailure(error)}`, 503);
    }
  }

  const status = await getUpdateStatus({ fetch: true });
  const plan = getUpdatePlan(status, true);
  return jsonOk({ status, plan, cutover: await loadCutoverStatus(status) });
}

export async function POST(request: Request) {
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;

  const body = await request.json().catch(() => ({})) as { restart?: boolean };
  const restart = body.restart !== false;

  if (fs.existsSync(OPERATIONAL_UPDATER)) {
    let payload: OperationalUpdaterPayload;
    try {
      payload = await readOperationalUpdaterStatus();
    } catch (error) {
      return jsonError(`Operational updater status check failed: ${formatExecFailure(error)}`, 503);
    }

    if (!payload.plan.allowed) {
      return jsonError(payload.plan.message, 409);
    }

    try {
      await execFileAsync(SUDO, ["-n", SYSTEMCTL, "--no-block", "start", UPDATE_SERVICE], {
        timeout: 5_000,
        maxBuffer: 256 * 1024,
        env: process.env,
      });
      const cutover = await loadCutoverStatus(payload.status);
      return jsonOk({
        started: true,
        service: UPDATE_SERVICE,
        logDirectory: resolveUpdateLogDirectory(),
        status: payload.status,
        plan: payload.plan,
        cutover,
        warning: "HiveWright may restart while the privileged operational updater runs. Track progress from the update logs.",
      }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonError(`Failed to start operational updater service: ${message}`, 503);
    }
  }

  const status = await getUpdateStatus({ fetch: true });
  const plan = getUpdatePlan(status, restart);

  if (!plan.allowed) {
    return jsonError(plan.message, 409);
  }

  const logPath = updateLogPath();
  const out = fs.openSync(logPath, "a");
  const args = ["run", "hivewright:update", "--", "--apply", "--yes"];
  if (restart) args.push("--restart");

  const child = spawn("npm", args, {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });

  child.unref();
  fs.closeSync(out);

  const cutover = await loadCutoverStatus(status);
  return jsonOk({
    started: true,
    pid: child.pid,
    logPath,
    status,
    plan,
    cutover,
    warning: "HiveWright may restart while this update runs. Track progress from the log path or terminal.",
  }, 202);
}
