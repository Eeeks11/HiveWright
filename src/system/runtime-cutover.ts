import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCKED_OPERATIONAL_INSTALL = "/home/trent/apps/HiveWright";
const LEGACY_TOMBSTONE = "/home/trent/hivewrightv2";

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
