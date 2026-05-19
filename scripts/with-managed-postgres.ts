import * as fs from "node:fs";
import { spawn } from "node:child_process";
import * as process from "node:process";
import postgres from "postgres";
import {
  ensureLocalPostgresDirs,
  resolveLocalPostgresConfig,
  shouldUseManagedLocalPostgres,
} from "./lib/local-postgres";

const command = process.argv.slice(2);

if (command.length === 0) {
  console.error("[with-managed-postgres] no command provided");
  process.exit(1);
}

const config = resolveLocalPostgresConfig();

async function canConnectToManagedDatabase(url: string): Promise<boolean> {
  const sql = postgres(url, { max: 1, connect_timeout: 2 });
  try {
    const [row] = await sql<{ db: string; user: string }[]>`SELECT current_database() AS db, current_user AS user`;
    return row?.db === config.database && row.user === config.user;
  } catch {
    return false;
  } finally {
    await sql.end().catch(() => undefined);
  }
}

async function waitForPostgres(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not ready";

  while (Date.now() < deadline) {
    const sql = postgres(url, { max: 1, connect_timeout: 2 });
    try {
      await sql`SELECT 1`;
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await sql.end().catch(() => undefined);
    }
  }

  throw new Error(`embedded Postgres did not become ready in time: ${lastError}`);
}

async function withStartupLock<T>(fn: () => Promise<T>): Promise<T> {
  ensureLocalPostgresDirs(config);
  const deadline = Date.now() + 30_000;

  while (true) {
    try {
      fs.mkdirSync(config.lockDir, { mode: 0o700 });
      fs.writeFileSync(`${config.lockDir}/owner`, `${process.pid}\n`, { mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for embedded Postgres startup lock: ${config.lockDir}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  try {
    return await fn();
  } finally {
    fs.rmSync(config.lockDir, { recursive: true, force: true });
  }
}

function spawnDetachedDaemon() {
  ensureLocalPostgresDirs(config);
  const out = fs.openSync(config.logFile, "a", 0o600);
  const err = fs.openSync(config.logFile, "a", 0o600);
  const child = spawn("tsx", ["scripts/embedded-postgres-daemon.ts"], {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: ["ignore", out, err],
  });
  child.unref();
}

function shouldRunMigrations(): boolean {
  const joined = command.join(" ");
  return !joined.includes("scripts/migrate-app-db.ts") && process.env.HIVEWRIGHT_SKIP_LOCAL_DB_MIGRATIONS !== "1";
}

async function run(commandToRun: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return await new Promise((resolve) => {
    const child = spawn(commandToRun[0]!, commandToRun.slice(1), {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    });

    const forward = (signal: NodeJS.Signals) => {
      if (!child.killed) {
        child.kill(signal);
      }
    };
    process.once("SIGINT", forward);
    process.once("SIGTERM", forward);

    child.on("exit", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      if (signal) {
        resolve(128 + (signal === "SIGINT" ? 2 : 15));
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

async function main() {
  if (!shouldUseManagedLocalPostgres()) {
    process.exit(await run(command, process.env));
  }

  await withStartupLock(async () => {
    if (!(await canConnectToManagedDatabase(config.url))) {
      console.log(`[with-managed-postgres] DATABASE_URL is unset; starting managed local Postgres at ${config.safeUrl}`);
      spawnDetachedDaemon();
      await waitForPostgres(config.url);
    } else {
      console.log(`[with-managed-postgres] DATABASE_URL is unset; using managed local Postgres at ${config.safeUrl}`);
    }
  });

  const env = {
    ...process.env,
    DATABASE_URL: config.url,
    HIVEWRIGHT_MANAGED_DATABASE_URL: config.safeUrl,
  };

  if (shouldRunMigrations()) {
    const migrationExit = await run(["tsx", "scripts/migrate-app-db.ts"], env);
    if (migrationExit !== 0) {
      process.exit(migrationExit);
    }
  }

  process.exit(await run(command, env));
}

main().catch((error) => {
  console.error(`[with-managed-postgres] failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`[with-managed-postgres] embedded Postgres log: ${config.logFile}`);
  process.exit(1);
});
