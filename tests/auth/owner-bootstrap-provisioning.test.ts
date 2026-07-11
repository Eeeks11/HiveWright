import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  OWNER_SETUP_TOKEN_ENV,
  provisionOwnerBootstrap,
  removeOwnerSetupTokenFromSecrets,
} from "@/auth/owner-bootstrap-provisioning";
import {
  bootstrapFirstOwner,
  OWNER_BOOTSTRAP_DISABLED_TOKEN_HASH,
} from "@/auth/owner-bootstrap";
import {
  acquireSuiteIsolation,
  createFixtureNamespace,
  type TestDbIsolationLease,
  testSql as sql,
  truncateAll,
} from "../_lib/test-db";

const testRoot = path.join(process.cwd(), ".issue207-provisioning-test");
const secretsFile = path.join(testRoot, "secrets.env");
let lease: TestDbIsolationLease;

beforeAll(async () => {
  lease = await acquireSuiteIsolation(sql);
});

beforeEach(async () => {
  await truncateAll(sql, { preserveReadOnlyTables: false });
});

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

afterAll(async () => lease.release());

function readSetupToken(): string | undefined {
  if (!fs.existsSync(secretsFile)) return undefined;
  return fs.readFileSync(secretsFile, "utf8")
    .match(new RegExp(`^${OWNER_SETUP_TOKEN_ENV}=([^\\n]+)$`, "m"))?.[1];
}

async function insertExistingUser(active = true): Promise<void> {
  const fixture = createFixtureNamespace("owner-bootstrap-provisioning");
  await sql`
    INSERT INTO users (email, password_hash, is_system_owner, is_active)
    VALUES (${fixture.email("existing")}, 'not-used', true, ${active})
  `;
}

describe("owner bootstrap runtime secret cleanup", () => {
  it("atomically removes only the setup token and enforces owner-only mode", () => {
    fs.mkdirSync(testRoot, { recursive: true });
    fs.writeFileSync(
      secretsFile,
      `DATABASE_URL=postgres://local-test\n${OWNER_SETUP_TOKEN_ENV}=fake-test-token\nKEEP_ME=value\n`,
      { mode: 0o644 },
    );

    expect(removeOwnerSetupTokenFromSecrets(secretsFile)).toBe(true);
    const contents = fs.readFileSync(secretsFile, "utf8");
    expect(contents).toBe("DATABASE_URL=postgres://local-test\nKEEP_ME=value\n");
    expect(fs.statSync(secretsFile).mode & 0o777).toBe(0o600);
  });

  it("refuses a symlinked secrets path", () => {
    fs.mkdirSync(testRoot, { recursive: true });
    const target = path.join(testRoot, "target.env");
    fs.writeFileSync(target, `${OWNER_SETUP_TOKEN_ENV}=fake\n`, { mode: 0o600 });
    fs.symlinkSync(target, secretsFile);
    expect(() => removeOwnerSetupTokenFromSecrets(secretsFile)).toThrow(/regular file/);
  });
});

describe.sequential("owner bootstrap provisioning state", () => {
  it("backfills a permanent sentinel on legacy startup and cannot reopen after all users are deleted", async () => {
    await insertExistingUser();
    fs.mkdirSync(testRoot, { recursive: true });
    fs.writeFileSync(
      secretsFile,
      `KEEP_ME=value\n${OWNER_SETUP_TOKEN_ENV}=stale-legacy-token\n`,
      { mode: 0o600 },
    );

    expect(await provisionOwnerBootstrap(sql, secretsFile)).toBe("disabled");
    const [state] = await sql<{ tokenHash: string; consumedAt: Date | null }[]>`
      SELECT token_hash AS "tokenHash", consumed_at AS "consumedAt"
      FROM owner_bootstrap_state WHERE id = true
    `;
    expect(state.tokenHash).toBe(OWNER_BOOTSTRAP_DISABLED_TOKEN_HASH);
    expect(state.consumedAt).not.toBeNull();
    expect(readSetupToken()).toBeUndefined();
    expect(fs.readFileSync(secretsFile, "utf8")).toBe("KEEP_ME=value\n");

    await sql`DELETE FROM users`;
    expect(await provisionOwnerBootstrap(sql, secretsFile)).toBe("disabled");
    expect(await provisionOwnerBootstrap(sql, secretsFile)).toBe("disabled");
    expect(readSetupToken()).toBeUndefined();
    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM owner_bootstrap_state
    `;
    expect(count).toBe(1);
  });

  it("treats even inactive preexisting users as an initialized install", async () => {
    await insertExistingUser(false);
    expect(await provisionOwnerBootstrap(sql, secretsFile)).toBe("disabled");
    const [state] = await sql<{ tokenHash: string; consumedAt: Date | null }[]>`
      SELECT token_hash AS "tokenHash", consumed_at AS "consumedAt"
      FROM owner_bootstrap_state WHERE id = true
    `;
    expect(state.tokenHash).toBe(OWNER_BOOTSTRAP_DISABLED_TOKEN_HASH);
    expect(state.consumedAt).not.toBeNull();
    expect(readSetupToken()).toBeUndefined();
  });

  it("serializes concurrent provisioning on an initialized install into one sentinel", async () => {
    await insertExistingUser();
    const results = await Promise.all([
      provisionOwnerBootstrap(sql, secretsFile),
      provisionOwnerBootstrap(sql, secretsFile),
    ]);
    expect(results).toEqual(["disabled", "disabled"]);
    const [state] = await sql<{ count: number; tokenHash: string; consumedAt: Date | null }[]>`
      SELECT COUNT(*)::int AS count, MIN(token_hash)::text AS "tokenHash",
             MIN(consumed_at) AS "consumedAt"
      FROM owner_bootstrap_state
    `;
    expect(state.count).toBe(1);
    expect(state.tokenHash).toBe(OWNER_BOOTSTRAP_DISABLED_TOKEN_HASH);
    expect(state.consumedAt).not.toBeNull();
    expect(readSetupToken()).toBeUndefined();
  });

  it("fails closed and rolls back when the initialized-install sentinel cannot persist", async () => {
    await insertExistingUser();
    fs.mkdirSync(testRoot, { recursive: true });
    fs.writeFileSync(secretsFile, `${OWNER_SETUP_TOKEN_ENV}=stale-token\n`, { mode: 0o600 });
    await sql.unsafe(`
      CREATE FUNCTION issue244_reject_bootstrap_state() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'issue244 forced sentinel failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER issue244_reject_bootstrap_state
      BEFORE INSERT ON owner_bootstrap_state
      FOR EACH ROW EXECUTE FUNCTION issue244_reject_bootstrap_state();
    `);
    try {
      await expect(provisionOwnerBootstrap(sql, secretsFile)).rejects.toThrow(
        /issue244 forced sentinel failure/,
      );
      const [{ count }] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM owner_bootstrap_state
      `;
      expect(count).toBe(0);
      expect(readSetupToken()).toBeUndefined();
    } finally {
      await sql.unsafe(`
        DROP TRIGGER IF EXISTS issue244_reject_bootstrap_state ON owner_bootstrap_state;
        DROP FUNCTION IF EXISTS issue244_reject_bootstrap_state();
      `);
    }
  });

  it("provisions exactly one token for a fresh empty install and cleans up a rolled-back token", async () => {
    await sql.unsafe(`
      CREATE FUNCTION issue244_reject_bootstrap_state() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'issue244 forced fresh failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER issue244_reject_bootstrap_state
      BEFORE INSERT ON owner_bootstrap_state
      FOR EACH ROW EXECUTE FUNCTION issue244_reject_bootstrap_state();
    `);
    try {
      await expect(provisionOwnerBootstrap(sql, secretsFile)).rejects.toThrow(
        /issue244 forced fresh failure/,
      );
      expect(readSetupToken()).toBeUndefined();
      const [{ count }] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM owner_bootstrap_state
      `;
      expect(count).toBe(0);
    } finally {
      await sql.unsafe(`
        DROP TRIGGER IF EXISTS issue244_reject_bootstrap_state ON owner_bootstrap_state;
        DROP FUNCTION IF EXISTS issue244_reject_bootstrap_state();
      `);
    }

    expect(await provisionOwnerBootstrap(sql, secretsFile)).toBe("provisioned");
    const token = readSetupToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await provisionOwnerBootstrap(sql, secretsFile)).toBe("active");
    expect(readSetupToken()).toBe(token);
    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM owner_bootstrap_state
    `;
    expect(count).toBe(1);
  });

  it("keeps a consumed fresh install disabled and removes its setup token", async () => {
    expect(await provisionOwnerBootstrap(sql, secretsFile)).toBe("provisioned");
    const token = readSetupToken();
    expect(token).toBeDefined();
    const fixture = createFixtureNamespace("owner-bootstrap-consumed");
    const result = await bootstrapFirstOwner(sql, {
      email: fixture.email("owner"),
      password: "safe-password-244!",
      setupToken: token!,
      source: "provisioning-regression",
    });
    expect(result.ok).toBe(true);

    expect(await provisionOwnerBootstrap(sql, secretsFile)).toBe("disabled");
    expect(readSetupToken()).toBeUndefined();
    await sql`DELETE FROM users`;
    expect(await provisionOwnerBootstrap(sql, secretsFile)).toBe("disabled");
    expect(readSetupToken()).toBeUndefined();
  });
});
