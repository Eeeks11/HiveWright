import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { buildDoctorReport, type DoctorRuntime } from "../src/setup-doctor/reliability";

function commandAvailable(name: string) {
  const result = spawnSync("bash", ["-lc", `command -v ${name}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function npmScriptNames() {
  const parsed = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };
  return Object.keys(parsed.scripts ?? {});
}

async function dbReachable() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return { ok: false, detail: "DATABASE_URL is missing" };
  }
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 3, idle_timeout: 1 });
  try {
    await sql`SELECT 1`;
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "database connection failed" };
  } finally {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
}

async function migrationJournalOk() {
  const result = spawnSync("npx", ["tsx", "scripts/check-drizzle-journal.ts"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (result.status === 0) {
    return { ok: true };
  }
  const detail = [result.stdout, result.stderr].join("\n").trim() || "migration journal check failed";
  return { ok: false, detail };
}

async function main() {
  const runtime: DoctorRuntime = {
    env: process.env,
    commandAvailable,
    npmScriptNames,
    dbReachable,
    migrationJournalOk,
  };
  const report = await buildDoctorReport(runtime);
  console.log(report.markdown);
  if (report.status === "fail") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "doctor failed");
  process.exitCode = 1;
});
