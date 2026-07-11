import fs from "node:fs";
import path from "node:path";
import type { TransactionSql } from "postgres";
import { describe, expect, it } from "vitest";
import { OWNER_BOOTSTRAP_DISABLED_TOKEN_HASH } from "@/auth/owner-bootstrap";
import { testSql as sql } from "../_lib/test-db";

const MIGRATION_SQL = fs.readFileSync(
  path.join(process.cwd(), "drizzle", "0143_secure_owner_bootstrap.sql"),
  "utf8",
);
const ROLLBACK = new Error("issue244 migration test rollback");

async function createPre0143Schema(
  tx: TransactionSql,
): Promise<void> {
  await tx.unsafe(`
    CREATE SCHEMA issue244_owner_bootstrap_migration;
    SET LOCAL search_path = issue244_owner_bootstrap_migration;
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL,
      password_hash text NOT NULL,
      is_active boolean NOT NULL DEFAULT true
    );
  `);
}

describe.sequential("0143_secure_owner_bootstrap.sql", () => {
  it("backfills one permanent consumed sentinel when users predate the migration", async () => {
    await expect(sql.begin(async (tx) => {
      await createPre0143Schema(tx);
      await tx.unsafe(`
        INSERT INTO users (email, password_hash, is_active)
        VALUES ('legacy@example.test', 'not-used', false)
      `);

      await tx.unsafe(MIGRATION_SQL);
      await tx.unsafe(MIGRATION_SQL);

      const rows = await tx<{ tokenHash: string; consumedAt: Date | null; consumedBy: string | null }[]>`
        SELECT token_hash AS "tokenHash", consumed_at AS "consumedAt",
               consumed_by_user_id AS "consumedBy"
        FROM owner_bootstrap_state
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).toBe(OWNER_BOOTSTRAP_DISABLED_TOKEN_HASH);
      expect(rows[0].consumedAt).not.toBeNull();
      expect(rows[0].consumedBy).toBeNull();

      await tx`DELETE FROM users`;
      const [afterReset] = await tx<{ tokenHash: string; consumedAt: Date | null }[]>`
        SELECT token_hash AS "tokenHash", consumed_at AS "consumedAt"
        FROM owner_bootstrap_state WHERE id = true
      `;
      expect(afterReset.tokenHash).toBe(OWNER_BOOTSTRAP_DISABLED_TOKEN_HASH);
      expect(afterReset.consumedAt).not.toBeNull();
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
  });

  it("leaves a never-provisioned empty installation without bootstrap state", async () => {
    await expect(sql.begin(async (tx) => {
      await createPre0143Schema(tx);
      await tx.unsafe(MIGRATION_SQL);
      const [{ count }] = await tx<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM owner_bootstrap_state
      `;
      expect(count).toBe(0);
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
  });
});
