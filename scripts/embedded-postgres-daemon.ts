import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import * as process from "node:process";
import postgres from "postgres";
import {
  ensureLocalPostgresDirs,
  isInitialized,
  resolveLocalPostgresConfig,
} from "./lib/local-postgres";

const config = resolveLocalPostgresConfig();
const require = createRequire(import.meta.url);

type EmbeddedPostgresBinaries = {
  initdb: string;
  postgres: string;
};

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function log(message: string) {
  fs.appendFileSync(config.logFile, `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 });
}

async function loadBinaries(): Promise<EmbeddedPostgresBinaries> {
  const platform = os.platform();
  const arch = os.arch();
  const load = (packageName: string): EmbeddedPostgresBinaries => require(packageName) as EmbeddedPostgresBinaries;

  if (platform === "linux" && arch === "x64") return load("@embedded-postgres/linux-x64");
  if (platform === "linux" && arch === "arm64") return load("@embedded-postgres/linux-arm64");
  if (platform === "linux" && arch === "arm") return load("@embedded-postgres/linux-arm");
  if (platform === "linux" && arch === "ia32") return load("@embedded-postgres/linux-ia32");
  if (platform === "linux" && arch === "ppc64") return load("@embedded-postgres/linux-ppc64");
  if (platform === "darwin" && arch === "arm64") return load("@embedded-postgres/darwin-arm64");
  if (platform === "darwin" && arch === "x64") return load("@embedded-postgres/darwin-x64");
  if (platform === "win32" && arch === "x64") return load("@embedded-postgres/windows-x64");

  throw new Error(`Unsupported embedded Postgres platform: ${platform}/${arch}`);
}

async function runCommand(command: string, args: string[], redactedArgs: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, LC_MESSAGES: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout.on("data", (chunk) => log(chunk.toString("utf8").trimEnd()));
    child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8");
      stderr += message;
      log(message.trimEnd());
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Command failed: ${command} ${redactedArgs.join(" ")} (code=${code ?? "null"}, signal=${signal ?? "null"}) ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

async function initialiseCluster(binaries: EmbeddedPostgresBinaries) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const passwordFile = path.join(config.stateDir, `pg-password-${process.pid}`);
  fs.writeFileSync(passwordFile, `${config.password}\n`, { mode: 0o600 });
  try {
    await runCommand(
      binaries.initdb,
      [
        `--pgdata=${config.dataDir}`,
        "--auth=password",
        `--username=${config.user}`,
        `--pwfile=${passwordFile}`,
        "--lc-messages=C",
      ],
      [
        `--pgdata=${config.dataDir}`,
        "--auth=password",
        `--username=${config.user}`,
        "--pwfile=<redacted>",
        "--lc-messages=C",
      ],
    );
  } finally {
    fs.rmSync(passwordFile, { force: true });
  }
}

async function startPostgresProcess(binaries: EmbeddedPostgresBinaries): Promise<ChildProcess> {
  return await new Promise((resolve, reject) => {
    const child = spawn(binaries.postgres, ["-D", config.dataDir, "-p", String(config.port), "-h", "127.0.0.1"], {
      env: { ...process.env, LC_MESSAGES: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let resolved = false;
    const fail = (error: Error) => {
      if (!resolved) {
        resolved = true;
        reject(error);
      }
    };
    child.stdout.on("data", (chunk) => log(chunk.toString("utf8").trimEnd()));
    child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8");
      log(message.trimEnd());
      if (!resolved && message.includes("database system is ready to accept connections")) {
        resolved = true;
        resolve(child);
      }
    });
    child.on("error", fail);
    child.on("close", (code, signal) => fail(new Error(`postgres exited before ready (code=${code ?? "null"}, signal=${signal ?? "null"})`)));
  });
}

async function ensureDatabaseExists() {
  const adminUrl = `postgresql://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@127.0.0.1:${config.port}/postgres`;
  const sql = postgres(adminUrl, { max: 1 });
  try {
    const rows = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${config.database}) AS exists
    `;
    if (!rows[0]?.exists) {
      await sql.unsafe(`CREATE DATABASE ${quoteIdentifier(config.database)}`);
      log(`created database ${config.database}`);
    }
  } finally {
    await sql.end();
  }
}

async function main() {
  ensureLocalPostgresDirs(config);
  fs.writeFileSync(config.pidFile, `${process.pid}\n`, { mode: 0o600 });
  log(`embedded Postgres daemon starting on 127.0.0.1:${config.port}`);

  const binaries = await loadBinaries();
  if (!isInitialized(config)) {
    log(`initialising embedded Postgres cluster under ${config.dataDir}`);
    await initialiseCluster(binaries);
  }

  const postgresProcess = await startPostgresProcess(binaries);
  await ensureDatabaseExists();
  log("embedded Postgres daemon ready");

  const shutdown = (signal: string) => {
    log(`embedded Postgres daemon stopping after ${signal}`);
    postgresProcess.once("exit", () => {
      fs.rmSync(config.pidFile, { force: true });
      process.exit(0);
    });
    postgresProcess.kill("SIGINT");
    setTimeout(() => postgresProcess.kill("SIGKILL"), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await new Promise(() => undefined);
}

main().catch((error) => {
  ensureLocalPostgresDirs(config);
  log(`embedded Postgres daemon failed: ${error instanceof Error ? error.message : String(error)}`);
  fs.rmSync(config.pidFile, { force: true });
  process.exit(1);
});
