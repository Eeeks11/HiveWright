import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acquireSuiteIsolation,
  createFixtureNamespace,
  type TestDbIsolationLease,
  testSql as sql,
  truncateAll,
} from "../_lib/test-db";
import {
  bootstrapFirstOwner,
  hashOwnerBootstrapToken,
  OWNER_BOOTSTRAP_RATE_LIMIT,
  OWNER_BOOTSTRAP_GLOBAL_RATE_LIMIT,
  ownerBootstrapSourceKey,
  ownerSetupRequired,
} from "@/auth/owner-bootstrap";

const TOKEN = "issue-207-test-token-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
let lease: TestDbIsolationLease;

beforeAll(async () => {
  lease = await acquireSuiteIsolation(sql);
});

beforeEach(async () => {
  await truncateAll(sql, { preserveReadOnlyTables: false });
  await sql`
    INSERT INTO owner_bootstrap_state (id, token_hash)
    VALUES (true, ${hashOwnerBootstrapToken(TOKEN)})
  `;
});

afterAll(async () => lease.release());

function attempt(overrides: Partial<Parameters<typeof bootstrapFirstOwner>[1]> = {}) {
  const fixture = createFixtureNamespace("owner-bootstrap");
  return bootstrapFirstOwner(sql, {
    email: fixture.email("owner"),
    password: "safe-password-207!",
    displayName: "Owner",
    setupToken: TOKEN,
    source: "198.51.100.20",
    ...overrides,
  });
}

describe.sequential("secure first-owner bootstrap", () => {
  it("rejects missing and wrong tokens with the same result and sanitized audit", async () => {
    const missing = await attempt({ setupToken: "", source: "missing-source" });
    const wrong = await attempt({ setupToken: "wrong", source: "wrong-source" });
    expect(missing).toEqual({ ok: false, reason: "denied" });
    expect(wrong).toEqual(missing);

    const attempts = await sql<Array<{ sourceKey: string; outcome: string; payload: string }>>`
      SELECT source_key AS "sourceKey", outcome, row_to_json(owner_bootstrap_attempts)::text AS payload
      FROM owner_bootstrap_attempts ORDER BY id
    `;
    expect(attempts).toHaveLength(2);
    expect(attempts[0].sourceKey).toBe(ownerBootstrapSourceKey("missing-source"));
    expect(attempts.map((row) => row.outcome)).toEqual(["denied", "denied"]);
    expect(attempts.map((row) => row.payload).join(" ")).not.toContain(TOKEN);
    expect(attempts.map((row) => row.payload).join(" ")).not.toContain("safe-password");
    expect(attempts.map((row) => row.payload).join(" ")).not.toContain("198.51.100");
  });

  it("creates exactly one owner and permanently rejects token reuse", async () => {
    const first = await attempt();
    expect(first.ok).toBe(true);
    expect(await ownerSetupRequired(sql)).toBe(false);
    const reused = await attempt({ email: "other@example.test", source: "reuse" });
    expect(reused).toEqual({ ok: false, reason: "denied" });
    const [count] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM users`;
    expect(count.count).toBe(1);
  });

  it("allows exactly one of two concurrent valid requests", async () => {
    const [a, b] = await Promise.all([
      attempt({ email: "concurrent-a@example.test", source: "concurrent-a" }),
      attempt({ email: "concurrent-b@example.test", source: "concurrent-b" }),
    ]);
    expect([a, b].filter((result) => result.ok)).toHaveLength(1);
    const [count] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM users`;
    expect(count.count).toBe(1);
  });

  it("does not consume the token when the owner insert rolls back", async () => {
    await expect(attempt({ email: "not-an-email".repeat(40) })).rejects.toThrow();
    const [state] = await sql<{ consumedAt: Date | null }[]>`
      SELECT consumed_at AS "consumedAt" FROM owner_bootstrap_state WHERE id = true
    `;
    expect(state.consumedAt).toBeNull();
    const retry = await attempt({ email: "rollback-retry@example.test" });
    expect(retry.ok).toBe(true);
  });

  it("rate limits a source within a bounded window", async () => {
    for (let i = 0; i < OWNER_BOOTSTRAP_RATE_LIMIT; i += 1) {
      expect(await attempt({ setupToken: "wrong", source: "rate-source" }))
        .toEqual({ ok: false, reason: "denied" });
    }
    expect(await attempt({ source: "rate-source" }))
      .toEqual({ ok: false, reason: "rate_limited" });
    const [count] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM owner_bootstrap_attempts
      WHERE source_key = ${ownerBootstrapSourceKey("rate-source")}
    `;
    expect(count.count).toBe(OWNER_BOOTSTRAP_RATE_LIMIT + 1);
  });

  it("enforces a global bound even when sources are rotated", async () => {
    for (let i = 0; i < OWNER_BOOTSTRAP_GLOBAL_RATE_LIMIT; i += 1) {
      await sql`
        INSERT INTO owner_bootstrap_attempts (source_key, outcome)
        VALUES (${ownerBootstrapSourceKey(`rotated-${i}`)}, 'denied')
      `;
    }
    expect(await attempt({ source: "fresh-rotated-source" }))
      .toEqual({ ok: false, reason: "rate_limited" });
  });

  it("keeps initialized and legacy unprovisioned setup state disabled", async () => {
    await sql`DELETE FROM owner_bootstrap_state`;
    expect(await ownerSetupRequired(sql)).toBe(false);
    expect(await attempt()).toEqual({ ok: false, reason: "denied" });

    await sql`
      INSERT INTO users (email, password_hash, is_system_owner)
      VALUES ('existing@example.test', 'not-used', true)
    `;
    expect(await ownerSetupRequired(sql)).toBe(false);
  });
});
