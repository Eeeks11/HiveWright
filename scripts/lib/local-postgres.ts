import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const LOCAL_POSTGRES_DATABASE = "hivewrightv2";
export const LOCAL_POSTGRES_USER = "hivewright";
export const LOCAL_POSTGRES_PASSWORD = "hivewright-local-dev";
export const LOCAL_POSTGRES_DEFAULT_PORT = 55432;

type EnvLike = Record<string, string | undefined>;

export type LocalPostgresConfig = {
  runtimeRoot: string;
  stateDir: string;
  dataDir: string;
  lockDir: string;
  logFile: string;
  pidFile: string;
  port: number;
  database: string;
  user: string;
  password: string;
  url: string;
  safeUrl: string;
};

export function resolveRuntimeRoot(env: EnvLike = process.env): string {
  return path.resolve(env.HIVEWRIGHT_RUNTIME_ROOT || path.join(env.HOME || os.homedir(), ".hivewright"));
}

export function resolveLocalPostgresConfig(env: EnvLike = process.env): LocalPostgresConfig {
  const runtimeRoot = resolveRuntimeRoot(env);
  const port = parsePort(env.HIVEWRIGHT_EMBEDDED_POSTGRES_PORT);
  const stateDir = path.join(runtimeRoot, "postgres");
  const dataDir = path.join(stateDir, "data");
  const lockDir = path.join(stateDir, "startup.lock");
  const logFile = path.join(stateDir, "postgres.log");
  const pidFile = path.join(stateDir, "postgres.pid");
  const database = env.HIVEWRIGHT_EMBEDDED_POSTGRES_DB || LOCAL_POSTGRES_DATABASE;
  const user = env.HIVEWRIGHT_EMBEDDED_POSTGRES_USER || LOCAL_POSTGRES_USER;
  const password = env.HIVEWRIGHT_EMBEDDED_POSTGRES_PASSWORD || LOCAL_POSTGRES_PASSWORD;
  const encodedUser = encodeURIComponent(user);
  const encodedPassword = encodeURIComponent(password);
  const encodedDatabase = encodeURIComponent(database);
  const url = `postgresql://${encodedUser}:${encodedPassword}@127.0.0.1:${port}/${encodedDatabase}`;
  const safeUrl = `postgresql://${encodedUser}:***@127.0.0.1:${port}/${encodedDatabase}`;

  return {
    runtimeRoot,
    stateDir,
    dataDir,
    lockDir,
    logFile,
    pidFile,
    port,
    database,
    user,
    password,
    url,
    safeUrl,
  };
}

export function shouldUseManagedLocalPostgres(env: EnvLike = process.env): boolean {
  return !env.DATABASE_URL || env.DATABASE_URL.trim() === "";
}

export function ensureLocalPostgresDirs(config: Pick<LocalPostgresConfig, "stateDir">): void {
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
}

export function isInitialized(config: Pick<LocalPostgresConfig, "dataDir">): boolean {
  return fs.existsSync(path.join(config.dataDir, "PG_VERSION"));
}

function parsePort(value: string | undefined): number {
  if (!value) {
    return LOCAL_POSTGRES_DEFAULT_PORT;
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid HIVEWRIGHT_EMBEDDED_POSTGRES_PORT: ${value}`);
  }
  return port;
}
