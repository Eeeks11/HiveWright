import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { jsonError, jsonOk } from "../../_lib/responses";
import { requireApiAuth, requireSystemOwner } from "../../_lib/auth";
import { getUpdatePlan, getUpdateStatus } from "@/system/update-runtime";
import { resolveUpdateLogDirectory } from "@/system/update-logs";

const execFileAsync = promisify(execFile);
const OPERATIONAL_UPDATER = process.env.HIVEWRIGHT_OPERATIONAL_UPDATER ?? "/usr/local/sbin/hivewright-operational-update";
const SYSTEMCTL = process.env.HIVEWRIGHT_SYSTEMCTL ?? "/usr/bin/systemctl";
const SUDO = process.env.HIVEWRIGHT_SUDO ?? "/usr/bin/sudo";
const UPDATE_SERVICE = process.env.HIVEWRIGHT_UPDATE_SERVICE ?? "hivewright-update.service";

function updateLogPath() {
  const dir = resolveUpdateLogDirectory();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `update-${stamp}.log`);
}

export async function GET() {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  if (fs.existsSync(OPERATIONAL_UPDATER)) {
    try {
      const { stdout } = await execFileAsync(SUDO, ["-n", OPERATIONAL_UPDATER, "status-json"], {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        env: process.env,
      });
      return jsonOk(JSON.parse(stdout));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonError(`Operational updater status check failed: ${message}`, 503);
    }
  }

  const status = await getUpdateStatus({ fetch: true });
  const plan = getUpdatePlan(status, true);
  return jsonOk({ status, plan });
}

export async function POST(request: Request) {
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;

  const body = await request.json().catch(() => ({})) as { restart?: boolean };
  const restart = body.restart !== false;
  const status = await getUpdateStatus({ fetch: true });
  const plan = getUpdatePlan(status, restart);

  if (!plan.allowed) {
    return jsonError(plan.message, 409);
  }

  if (fs.existsSync(OPERATIONAL_UPDATER)) {
    try {
      await execFileAsync(SUDO, ["-n", SYSTEMCTL, "start", UPDATE_SERVICE], {
        timeout: 15_000,
        maxBuffer: 256 * 1024,
        env: process.env,
      });
      return jsonOk({
        started: true,
        service: UPDATE_SERVICE,
        logDirectory: resolveUpdateLogDirectory(),
        status,
        plan,
        warning: "HiveWright may restart while the privileged operational updater runs. Track progress from the update logs.",
      }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonError(`Failed to start operational updater service: ${message}`, 503);
    }
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

  return jsonOk({
    started: true,
    pid: child.pid,
    logPath,
    status,
    plan,
    warning: "HiveWright may restart while this update runs. Track progress from the log path or terminal.",
  }, 202);
}
