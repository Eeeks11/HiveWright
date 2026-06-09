#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildRuntimeBuildCommands,
  buildRuntimeCutoverConfig,
  buildRuntimeDeploymentProvenance,
  writeRuntimeServiceFiles,
} from "../src/system/runtime-cutover";

const execFileAsync = promisify(execFile);

type Options = {
  repo: string;
  runtimeCheckout: string;
  ref: string;
  runtimeRoot?: string;
  serviceDirectory?: string;
  readinessUrl?: string;
  skipRestart: boolean;
};

function readOption(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function requireOption(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing required option: ${label}`);
  return value;
}

async function run(command: string, args: string[], cwd?: string) {
  const result = await execFileAsync(command, args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    env: process.env,
  });
  return result.stdout.trim();
}

async function ensureCleanRuntimeCheckout(runtimeCheckout: string) {
  const dirty = await run("git", ["status", "--porcelain"], runtimeCheckout);
  if (dirty) {
    throw new Error(`Runtime checkout is dirty: ${runtimeCheckout}`);
  }
}

async function ensureRuntimeWorktree(repo: string, runtimeCheckout: string, ref: string) {
  try {
    await fs.access(runtimeCheckout);
    await ensureCleanRuntimeCheckout(runtimeCheckout);
    await run("git", ["checkout", "--detach", ref], runtimeCheckout);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await run("git", ["worktree", "add", "--detach", runtimeCheckout, ref], repo);
  }
}

async function buildRuntime(runtimeCheckout: string) {
  for (const [command, args] of buildRuntimeBuildCommands()) {
    await run(command, args, runtimeCheckout);
  }
}

async function restartServices(skipRestart: boolean) {
  if (skipRestart) return;
  await run("systemctl", ["--user", "daemon-reload"]);
  await run("systemctl", ["--user", "restart", "hivewright-dashboard.service", "hivewright-dispatcher.service"]);
}

async function serviceCwd(unit: string) {
  const pid = (await run("systemctl", ["--user", "show", unit, "-p", "MainPID", "--value"])).trim();
  if (!pid || pid === "0") throw new Error(`Unit has no running PID: ${unit}`);
  return fs.realpath(path.join("/proc", pid, "cwd"));
}

async function readReadiness(url: string) {
  const response = await fetch(url);
  const body = await response.json();
  return { status: response.status, body };
}

async function waitForReadiness(url: string, attempts = 30, delayMs = 1000) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      const readiness = await readReadiness(url);
      if (readiness.status === 200) return readiness;
      lastError = new Error(`Readiness returned ${readiness.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function writeProvenance(
  deploymentLogDirectory: string,
  provenance: ReturnType<typeof buildRuntimeDeploymentProvenance>,
) {
  await fs.mkdir(deploymentLogDirectory, { recursive: true });
  const stamp = provenance.deployedAt.replace(/[:.]/g, "-");
  const outputPath = path.join(deploymentLogDirectory, `runtime-cutover-${stamp}.json`);
  await fs.writeFile(outputPath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(deploymentLogDirectory, "latest-runtime-cutover.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
  return outputPath;
}

async function main() {
  const options: Options = {
    repo: path.resolve(requireOption(readOption("repo"), "repo")),
    runtimeCheckout: path.resolve(requireOption(readOption("runtime-checkout"), "runtime-checkout")),
    ref: readOption("ref") ?? "HEAD",
    runtimeRoot: readOption("runtime-root"),
    serviceDirectory: readOption("service-directory"),
    readinessUrl: readOption("readiness-url"),
    skipRestart: hasFlag("skip-restart"),
  };

  const config = buildRuntimeCutoverConfig({
    runtimeCheckout: options.runtimeCheckout,
    runtimeRoot: options.runtimeRoot,
    serviceDirectory: options.serviceDirectory,
    readinessUrl: options.readinessUrl,
  });

  await ensureRuntimeWorktree(options.repo, config.runtimeCheckout, options.ref);
  await buildRuntime(config.runtimeCheckout);
  writeRuntimeServiceFiles(config);
  await restartServices(options.skipRestart);

  const deployedCommit = await run("git", ["rev-parse", "HEAD"], config.runtimeCheckout);
  const dashboardCwd = options.skipRestart ? null : await serviceCwd("hivewright-dashboard.service");
  const dispatcherCwd = options.skipRestart ? null : await serviceCwd("hivewright-dispatcher.service");
  const readiness = options.skipRestart ? null : await waitForReadiness(config.readinessUrl);

  const provenance = buildRuntimeDeploymentProvenance(config, {
    sourceRepo: options.repo,
    requestedRef: options.ref,
    deployedCommit,
    deployedAt: new Date().toISOString(),
    readinessUrl: config.readinessUrl,
  });
  const provenancePath = await writeProvenance(config.deploymentLogDirectory, provenance);

  console.log(JSON.stringify({
    deployedCommit,
    runtimeCheckout: config.runtimeCheckout,
    dashboardCwd,
    dispatcherCwd,
    readiness,
    provenancePath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
