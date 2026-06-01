/**
 * Ensures the `hivewright_test` database exists, has pgvector enabled,
 * and is fully migrated. Idempotent — safe to run repeatedly.
 *
 * Refuses to run against any database name outside the test prefix
 * as a safety net so we never accidentally migrate or truncate prod.
 *
 * pgvector is optional. Tests that need vector-backed tables should skip when
 * the local Postgres binary cannot provide the extension.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { applyOutOfJournalMigrations, MIGRATIONS_FOLDER } from "./lib/drizzle-migrations";
import { resolveTestDatabaseConfig } from "./lib/test-db-config";
import { syncRoleLibrary } from "../src/roles/sync";

async function main() {
  const config = await resolveTestDatabaseConfig();
  process.env.TEST_ADMIN_URL = config.adminUrl;
  process.env.TEST_DATABASE_URL = config.testUrl;
  process.env.DATABASE_URL = config.testUrl;
  const preserveExisting = process.env.HIVEWRIGHT_PRESERVE_TEST_DB === "1";

  // 1. Ensure database exists.
  const admin = postgres(config.adminUrl);
  try {
    const rows = await admin`
      SELECT 1 FROM pg_database WHERE datname = ${config.databaseName}
    `;
    if (rows.length > 0 && !preserveExisting) {
      console.log(`[setup-test-db] dropping database ${config.databaseName}`);
      await admin.unsafe(`DROP DATABASE ${config.databaseName} WITH (FORCE)`);
    }

    if (rows.length === 0 || !preserveExisting) {
      console.log(`[setup-test-db] creating database ${config.databaseName}`);
      // CREATE DATABASE cannot be parameterised; identifier is a hardcoded
      // constant above, so this is safe from injection.
      await admin.unsafe(`CREATE DATABASE ${config.databaseName}`);
    } else {
      console.log(`[setup-test-db] database ${config.databaseName} already exists`);
    }
  } finally {
    await admin.end();
  }

  // 2. Enable pgvector + run migrations.
  const sql = postgres(config.testUrl, { max: 1 });
  try {
    // Safety net: refuse if we somehow connected to the wrong DB.
    const [row] = await sql`SELECT current_database() AS db`;
    if (row.db !== config.databaseName) {
      throw new Error(
        `[setup-test-db] aborting: connected to '${row.db}', expected '${config.databaseName}'`,
      );
    }

    try {
      await sql`CREATE EXTENSION IF NOT EXISTS vector`;
      console.log(`[setup-test-db] pgvector enabled`);
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      const msg = err instanceof Error ? err.message : String(err);
      if (code === "42501" || msg.includes("permission denied") || msg.includes("superuser")) {
        throw new Error(
          `[setup-test-db] cannot install pgvector: ${msg}`,
        );
      }
      if (code === "0A000" || msg.includes("extension \"vector\" is not available")) {
        console.log(`[setup-test-db] pgvector unavailable; vector-backed optional tables will be skipped`);
      } else {
        throw err;
      }
    }

    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    console.log(`[setup-test-db] migrations applied`);

    // Drizzle's migrator only applies what's in meta/_journal.json. Every
    // migration from 0016 onwards was added without regenerating the journal,
    // so we apply them here as a safety net on test-db rebuilds.
    await applyOutOfJournalMigrations(sql);

    // Tests preserve role_templates across truncateAll() and many dormant-goal
    // paths rely on assigned_to FKs. Sync the real role library here so a
    // clean test DB matches dispatcher startup expectations.
    await syncRoleLibrary(path.resolve(process.cwd(), "role-library"), sql);
    console.log(`[setup-test-db] role library synced`);

    // Install runtime objects the dispatcher creates on startup but that
    // aren't in drizzle migrations. Tests that assert on these (e.g.
    // tests/db/schema.test.ts checking task_insert_notify) need them in
    // the test DB even though no dispatcher is running against it.
    // Source of truth: src/dispatcher/index.ts:62-79.
    await sql`
      CREATE OR REPLACE FUNCTION notify_new_task() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_notify('new_task', NEW.id::text);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;
    await sql`DROP TRIGGER IF EXISTS task_insert_notify ON tasks`;
    await sql`
      CREATE TRIGGER task_insert_notify
        AFTER INSERT ON tasks
        FOR EACH ROW
        EXECUTE FUNCTION notify_new_task()
    `;
    await sql`
      CREATE OR REPLACE FUNCTION notify_new_goal_comment() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_notify('new_goal_comment', NEW.id::text);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;
    await sql`DROP TRIGGER IF EXISTS goal_comment_insert_notify ON goal_comments`;
    await sql`
      CREATE TRIGGER goal_comment_insert_notify
        AFTER INSERT ON goal_comments
        FOR EACH ROW
        EXECUTE FUNCTION notify_new_goal_comment()
    `;
    await sql`
      CREATE OR REPLACE FUNCTION notify_new_decision_message() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_notify('new_decision_message', NEW.id::text);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;
    await sql`DROP TRIGGER IF EXISTS decision_message_insert_notify ON decision_messages`;
    await sql`
      CREATE TRIGGER decision_message_insert_notify
        AFTER INSERT ON decision_messages
        FOR EACH ROW
        EXECUTE FUNCTION notify_new_decision_message()
    `;
    console.log(`[setup-test-db] dispatcher runtime objects installed`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("[setup-test-db] failed:", err);
  process.exit(1);
});
