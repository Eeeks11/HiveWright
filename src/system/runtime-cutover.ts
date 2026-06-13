import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRuntimePath } from "@/runtime/paths";

const LOCKED_OPERATIONAL_INSTALL = "/home/trent/apps/HiveWright";
const LEGACY_TOMBSTONE = "/home/trent/hivewrightv2";

export const RUNTIME_CUTOVER_FILENAME = "latest-runtime-cutover.json";

export type RuntimeMode = "locked-install" | "runtime-worktree";

export type RuntimeCutoverConfigInput = {
  serviceUser?: string;
  runtimeCheckout: string;
  runtimeRoot?: string;
  serviceDirectory?: string;
  readinessUrl?: string;
};

export type RuntimeCutoverConfig = {
  serviceUser: string;
  runtimeCheckout: string;
  runtimeRoot: string;
  envFile: string;
  secretsFile: string;
  serviceDirectory: string;
  dashboardUnitPath: string;
  dispatcherUnitPath: string;
  dispatcherGuardDirectory: string;
  dispatcherGuardPath: string;
  deploymentLogDirectory: string;
  readinessUrl: string;
};

export type RuntimeDeploymentProvenance = {
  serviceUser: string;
  sourceRepo: string;
  requestedRef: string;
  deployedCommit: string;
  deployedAt: string;
  runtimeCheckout: string;
  runtimeRoot: string;
  readinessUrl: string;
  systemd: {
    dashboardUnit: string;
    dispatcherUnit: string;
    dispatcherGuard: string;
  };
};

export interface RuntimeCutoverServiceRecord {
  pid: number | null;
  cwd: string | null;
}

export interface RuntimeCutoverRecord {
  recordedAt: string | null;
  runtimeMode: RuntimeMode | null;
  installDir: string | null;
  runtimeRoot: string | null;
  envFile: string | null;
  dashboardHealthUrl: string | null;
  deployedCommit: string | null;
  buildHash: string | null;
  dashboard: RuntimeCutoverServiceRecord;
  dispatcher: RuntimeCutoverServiceRecord;
}

export interface RuntimeCutoverReadResult {
  path: string;
  record: RuntimeCutoverRecord | null;
  error: string | null;
}

export interface RuntimeCutoverStatus {
  path: string;
  available: boolean;
  state: "in_sync" | "drift" | "unavailable";
  reasons: string[];
  record: RuntimeCutoverRecord | null;
}

export interface RuntimeCutoverExpectation {
  installDir?: string | null;
  runtimeRoot?: string | null;
  envFile?: string | null;
  dashboardHealthUrl?: string | null;
  currentCommit?: string | null;
  currentBuildHash?: string | null;
  runtimeMode?: RuntimeMode | null;
}

type RuntimeCutoverSourceRecord = Partial<{
  recordedAt: unknown;
  completedAt: unknown;
  runtimeMode: unknown;
  installDir: unknown;
  runtimeCheckout: unknown;
  runtimeRoot: unknown;
  envFile: unknown;
  dashboardHealthUrl: unknown;
  deployedCommit: unknown;
  buildHash: unknown;
  dashboard: unknown;
  dispatcher: unknown;
}>;

export function buildRuntimeBuildCommands(): [string, string[]][] {
  return [
    ["npm", ["install", "--include=dev"]],
    ["npm", ["run", "db:migrate:app"]],
    ["npm", ["run", "build:runtime"]],
    ["npm", ["run", "build:dispatcher"]],
  ];
}

export function buildRuntimeCutoverConfig(input: RuntimeCutoverConfigInput): RuntimeCutoverConfig {
  const serviceUser = input.serviceUser ?? os.userInfo().username;
  const runtimeCheckout = path.resolve(input.runtimeCheckout);
  if (runtimeCheckout !== LOCKED_OPERATIONAL_INSTALL) {
    throw new Error(
      `Refusing to render HiveWright services from writable runtime checkout ${runtimeCheckout}; ` +
        `services must run from locked operational install ${LOCKED_OPERATIONAL_INSTALL}`,
    );
  }
  const runtimeRoot = path.resolve(input.runtimeRoot ?? path.join(os.homedir(), ".hivewright"));
  const serviceDirectory = path.resolve(input.serviceDirectory ?? path.join(os.homedir(), ".config/systemd/user"));
  return {
    serviceUser,
    runtimeCheckout,
    runtimeRoot,
    envFile: path.join(runtimeRoot, "config/.env"),
    secretsFile: path.join(runtimeRoot, "secrets.env"),
    serviceDirectory,
    dashboardUnitPath: path.join(serviceDirectory, "hivewright-dashboard.service"),
    dispatcherUnitPath: path.join(serviceDirectory, "hivewright-dispatcher.service"),
    dispatcherGuardDirectory: path.join(serviceDirectory, "hivewright-dispatcher.service.d"),
    dispatcherGuardPath: path.join(serviceDirectory, "hivewright-dispatcher.service.d/10-legacy-path-guard.conf"),
    deploymentLogDirectory: path.join(runtimeRoot, "logs/deployments"),
    readinessUrl: input.readinessUrl ?? "http://127.0.0.1:3002/api/readiness",
  };
}

export function renderDashboardUserService(config: RuntimeCutoverConfig): string {
  return `[Unit]
Description=HiveWright Dashboard (Next.js)
After=network.target

[Service]
Type=simple
WorkingDirectory=${config.runtimeCheckout}
ExecStart=/usr/bin/npm run start -- -H 127.0.0.1
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=HIVEWRIGHT_RUNTIME_ROOT=${config.runtimeRoot}
Environment=HIVEWRIGHT_ENV_FILE=${config.envFile}
Environment=HIVEWRIGHT_SECRETS_FILE=${config.secretsFile}
EnvironmentFile=${config.envFile}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

export function renderDispatcherUserService(config: RuntimeCutoverConfig): string {
  return `[Unit]
Description=HiveWright Dispatcher
After=network.target hivewright-dashboard.service
Wants=hivewright-dashboard.service

[Service]
Type=simple
WorkingDirectory=${config.runtimeCheckout}
ExecStart=/bin/bash ${config.runtimeCheckout}/start-dispatcher.sh
Restart=always
RestartSec=15
Environment=NODE_ENV=production
Environment=HIVEWRIGHT_RUNTIME_ROOT=${config.runtimeRoot}
Environment=HIVEWRIGHT_ENV_FILE=${config.envFile}
Environment=HIVEWRIGHT_SECRETS_FILE=${config.secretsFile}
Environment="NODE_OPTIONS=--require ${config.runtimeRoot}/runtime/force-local-listen.cjs"
EnvironmentFile=${config.envFile}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

export function renderDispatcherLegacyGuard(config: RuntimeCutoverConfig): string {
  return `[Service]
ExecStartPre=/usr/bin/bash -lc 'test "$PWD" = "${config.runtimeCheckout}" || { echo "HiveWright dispatcher cwd guard failed: $PWD" >&2; exit 1; }; test "${config.runtimeCheckout}" = "${LOCKED_OPERATIONAL_INSTALL}" || { echo "HiveWright dispatcher must run from locked install ${LOCKED_OPERATIONAL_INSTALL}" >&2; exit 1; }; test ! -e ${LEGACY_TOMBSTONE}/.git || { echo "Forbidden legacy repo ${LEGACY_TOMBSTONE} exists; refusing dispatcher start" >&2; exit 1; }; grep -q "FORBIDDEN LEGACY TOMBSTONE" ${LEGACY_TOMBSTONE}/AGENTS.md || { echo "Legacy tombstone missing; refusing dispatcher start" >&2; exit 1; }'
`;
}

export function buildRuntimeDeploymentProvenance(
  config: RuntimeCutoverConfig,
  input: Omit<RuntimeDeploymentProvenance, "serviceUser" | "runtimeCheckout" | "runtimeRoot" | "systemd">,
): RuntimeDeploymentProvenance {
  return {
    serviceUser: config.serviceUser,
    sourceRepo: input.sourceRepo,
    requestedRef: input.requestedRef,
    deployedCommit: input.deployedCommit,
    deployedAt: input.deployedAt,
    runtimeCheckout: config.runtimeCheckout,
    runtimeRoot: config.runtimeRoot,
    readinessUrl: input.readinessUrl,
    systemd: {
      dashboardUnit: config.dashboardUnitPath,
      dispatcherUnit: config.dispatcherUnitPath,
      dispatcherGuard: config.dispatcherGuardPath,
    },
  };
}

export function writeRuntimeServiceFiles(config: RuntimeCutoverConfig) {
  fs.mkdirSync(config.serviceDirectory, { recursive: true });
  fs.mkdirSync(config.dispatcherGuardDirectory, { recursive: true });
  fs.writeFileSync(config.dashboardUnitPath, renderDashboardUserService(config));
  fs.writeFileSync(config.dispatcherUnitPath, renderDispatcherUserService(config));
  fs.writeFileSync(config.dispatcherGuardPath, renderDispatcherLegacyGuard(config));
}

export function resolveRuntimeCutoverPath(
  env: { [key: string]: string | undefined } = process.env,
  repoRoot = process.cwd(),
): string {
  return resolveRuntimePath(["logs", "deployments", RUNTIME_CUTOVER_FILENAME], env, repoRoot);
}

export async function readRuntimeCutoverRecord(options: {
  env?: { [key: string]: string | undefined };
  repoRoot?: string;
  cutoverPath?: string;
} = {}): Promise<RuntimeCutoverReadResult> {
  const cutoverPath = options.cutoverPath
    ?? resolveRuntimeCutoverPath(options.env ?? process.env, options.repoRoot ?? process.cwd());

  try {
    const raw = await fsPromises.readFile(cutoverPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return {
      path: cutoverPath,
      record: normalizeRuntimeCutoverRecord(parsed),
      error: null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        path: cutoverPath,
        record: null,
        error: "Runtime cutover record has not been written yet.",
      };
    }
    return {
      path: cutoverPath,
      record: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function evaluateRuntimeCutover(
  input: RuntimeCutoverReadResult & { expected?: RuntimeCutoverExpectation },
): RuntimeCutoverStatus {
  if (!input.record) {
    return {
      path: input.path,
      available: false,
      state: "unavailable",
      reasons: input.error ? [input.error] : ["Runtime cutover record is unavailable."],
      record: null,
    };
  }

  const reasons: string[] = [];
  const expected = input.expected ?? {};
  const record = input.record;

  if (!record.runtimeMode) reasons.push("Runtime cutover record does not declare runtimeMode.");
  if (!record.installDir) reasons.push("Runtime cutover record does not declare installDir.");
  if (!record.runtimeRoot) reasons.push("Runtime cutover record does not declare runtimeRoot.");
  if (!record.recordedAt) reasons.push("Runtime cutover record does not declare recordedAt.");

  compareField(reasons, "runtimeMode", expected.runtimeMode ?? null, record.runtimeMode);
  compareField(reasons, "installDir", expected.installDir ?? null, record.installDir);
  compareField(reasons, "runtimeRoot", expected.runtimeRoot ?? null, record.runtimeRoot);
  compareField(reasons, "envFile", expected.envFile ?? null, record.envFile);
  compareField(reasons, "dashboardHealthUrl", expected.dashboardHealthUrl ?? null, record.dashboardHealthUrl);
  compareField(reasons, "deployedCommit", expected.currentCommit ?? null, record.deployedCommit);
  compareField(reasons, "buildHash", expected.currentBuildHash ?? null, record.buildHash);

  if (record.installDir && record.dashboard.cwd && record.dashboard.cwd !== record.installDir) {
    reasons.push(`dashboard cwd (${record.dashboard.cwd}) does not match installDir (${record.installDir})`);
  }
  if (record.installDir && record.dispatcher.cwd && record.dispatcher.cwd !== record.installDir) {
    reasons.push(`dispatcher cwd (${record.dispatcher.cwd}) does not match installDir (${record.installDir})`);
  }

  return {
    path: input.path,
    available: true,
    state: reasons.length === 0 ? "in_sync" : "drift",
    reasons,
    record,
  };
}

function compareField(reasons: string[], label: string, expected: string | null, actual: string | null) {
  if (!expected || !actual || expected === actual) return;
  reasons.push(`${label} drift: expected ${expected}, recorded ${actual}`);
}

function normalizeRuntimeCutoverRecord(value: unknown): RuntimeCutoverRecord {
  const record = isRecord(value) ? value as RuntimeCutoverSourceRecord : {};
  return {
    recordedAt: readString(record.recordedAt) ?? readString(record.completedAt),
    runtimeMode: readRuntimeMode(record.runtimeMode),
    installDir: readString(record.installDir) ?? readString(record.runtimeCheckout),
    runtimeRoot: readString(record.runtimeRoot),
    envFile: readString(record.envFile),
    dashboardHealthUrl: readString(record.dashboardHealthUrl),
    deployedCommit: readString(record.deployedCommit),
    buildHash: readString(record.buildHash),
    dashboard: readServiceRecord(record.dashboard),
    dispatcher: readServiceRecord(record.dispatcher),
  };
}

function readRuntimeMode(value: unknown): RuntimeMode | null {
  return value === "locked-install" || value === "runtime-worktree" ? value : null;
}

function readServiceRecord(value: unknown): RuntimeCutoverServiceRecord {
  if (!isRecord(value)) return { pid: null, cwd: null };
  return {
    pid: typeof value.pid === "number" ? value.pid : null,
    cwd: readString(value.cwd),
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
