import { createHash, timingSafeEqual } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { hashPassword } from "./password";
import type { AuthUser } from "./users";

type QuerySql = Sql | TransactionSql;

export const OWNER_BOOTSTRAP_LOCK_KEY = "hivewright:first-owner-bootstrap";
export const OWNER_BOOTSTRAP_RATE_LIMIT = 5;
export const OWNER_BOOTSTRAP_GLOBAL_RATE_LIMIT = 50;
export const OWNER_BOOTSTRAP_RATE_WINDOW_MINUTES = 15;
const OWNER_BOOTSTRAP_AUDIT_RETENTION_HOURS = 24;
const OWNER_BOOTSTRAP_AUDIT_MAX_ROWS = 10_000;
export const OWNER_BOOTSTRAP_DISABLED_TOKEN_HASH = createHash("sha256")
  .update("hivewright-owner-bootstrap-disabled")
  .digest("hex");

export type OwnerBootstrapInput = {
  email: string;
  password: string;
  displayName?: string;
  setupToken: string;
  source: string;
};

export type OwnerBootstrapResult =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: "denied" | "invalid_input" | "rate_limited" };

export function hashOwnerBootstrapToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function ownerBootstrapSourceKey(source: string): string {
  return createHash("sha256")
    .update(`hivewright:owner-bootstrap:${source || "unknown"}`, "utf8")
    .digest("hex");
}

function constantTimeHashEqual(candidateHash: string, expectedHash?: string): boolean {
  const candidate = Buffer.from(candidateHash, "hex");
  const expected = Buffer.from(expectedHash ?? OWNER_BOOTSTRAP_DISABLED_TOKEN_HASH, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

async function auditAttempt(
  tx: TransactionSql,
  sourceKey: string,
  outcome: string,
): Promise<void> {
  await tx`
    INSERT INTO owner_bootstrap_attempts (source_key, outcome)
    VALUES (${sourceKey}, ${outcome})
  `;
}

async function pruneAttemptAudit(tx: TransactionSql): Promise<void> {
  await tx`
    DELETE FROM owner_bootstrap_attempts
    WHERE created_at < NOW() - (${OWNER_BOOTSTRAP_AUDIT_RETENTION_HOURS} * INTERVAL '1 hour')
  `;
  await tx`
    DELETE FROM owner_bootstrap_attempts
    WHERE id IN (
      SELECT id FROM owner_bootstrap_attempts
      ORDER BY created_at DESC, id DESC
      OFFSET ${OWNER_BOOTSTRAP_AUDIT_MAX_ROWS}
    )
  `;
}

export async function bootstrapFirstOwner(
  sql: Sql,
  input: OwnerBootstrapInput,
): Promise<OwnerBootstrapResult> {
  const sourceKey = ownerBootstrapSourceKey(input.source);
  const candidateHash = hashOwnerBootstrapToken(input.setupToken ?? "");

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${OWNER_BOOTSTRAP_LOCK_KEY}))`;
    await pruneAttemptAudit(tx);

    const [rate] = await tx<{ sourceCount: number; globalCount: number }[]>`
      SELECT
        COUNT(*) FILTER (WHERE source_key = ${sourceKey})::int AS "sourceCount",
        COUNT(*)::int AS "globalCount"
      FROM owner_bootstrap_attempts
      WHERE created_at >= NOW() - (${OWNER_BOOTSTRAP_RATE_WINDOW_MINUTES} * INTERVAL '1 minute')
    `;
    if (
      (rate?.sourceCount ?? 0) >= OWNER_BOOTSTRAP_RATE_LIMIT
      || (rate?.globalCount ?? 0) >= OWNER_BOOTSTRAP_GLOBAL_RATE_LIMIT
    ) {
      await auditAttempt(tx, sourceKey, "rate_limited");
      return { ok: false, reason: "rate_limited" };
    }

    const [state] = await tx<{ tokenHash: string; consumedAt: Date | null }[]>`
      SELECT token_hash AS "tokenHash", consumed_at AS "consumedAt"
      FROM owner_bootstrap_state
      WHERE id = true
      FOR UPDATE
    `;
    const proofValid = constantTimeHashEqual(candidateHash, state?.tokenHash);
    if (!state || state.consumedAt || !proofValid) {
      await auditAttempt(tx, sourceKey, "denied");
      return { ok: false, reason: "denied" };
    }

    const [existing] = await tx<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM users WHERE is_active = true
    `;
    if ((existing?.count ?? 0) > 0) {
      await auditAttempt(tx, sourceKey, "denied");
      return { ok: false, reason: "denied" };
    }

    if (!input.email || !input.password || input.password.length < 8) {
      await auditAttempt(tx, sourceKey, "denied");
      return { ok: false, reason: "invalid_input" };
    }

    const passwordHash = hashPassword(input.password);
    const [user] = await tx<AuthUser[]>`
      INSERT INTO users (email, display_name, password_hash, is_system_owner)
      VALUES (${input.email}, ${input.displayName ?? null}, ${passwordHash}, true)
      RETURNING id, email, display_name AS "displayName",
                is_system_owner AS "isSystemOwner"
    `;
    await tx`
      UPDATE owner_bootstrap_state
      SET consumed_at = NOW(), consumed_by_user_id = ${user.id}
      WHERE id = true AND consumed_at IS NULL
    `;
    await auditAttempt(tx, sourceKey, "created");
    return { ok: true, user };
  });
}

export async function ownerSetupRequired(sql: QuerySql): Promise<boolean> {
  const [row] = await sql<{ ready: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM owner_bootstrap_state s
      WHERE s.id = true
        AND s.consumed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM users WHERE is_active = true)
    ) AS ready
  `;
  return Boolean(row?.ready);
}
