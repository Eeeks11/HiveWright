import type { Sql, TransactionSql } from "postgres";
import type { NextResponse } from "next/server";
import { canAccessHive, canMutateHive } from "@/auth/users";
import type { AuthenticatedApiUser } from "./auth";
import { jsonError } from "./responses";

type QuerySql = Sql | TransactionSql;

export const HIVE_TARGET_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StrictHiveTargetMode = "access" | "mutate";

export type StrictHiveTargetSource =
  | { kind: "query"; request: Request; key?: string }
  | { kind: "body"; body: Record<string, unknown>; key?: string }
  | { kind: "path"; params: Record<string, unknown>; key?: string };

export type StrictHiveTargetResult =
  | { ok: true; hiveId: string }
  | { ok: false; response: NextResponse };

export type ResourceOwnershipResult =
  | { ok: true }
  | { ok: false; response: NextResponse };

export function readHiveTarget(source: StrictHiveTargetSource): unknown {
  const key = source.key ?? "hiveId";
  if (source.kind === "query") {
    return new URL(source.request.url).searchParams.get(key);
  }
  if (source.kind === "path") {
    return source.params[key];
  }
  return source.body[key];
}

function normalizeTarget(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function hiveExists(db: QuerySql, hiveId: string): Promise<boolean> {
  const [row] = await db<{ id: string }[]>`
    SELECT id FROM hives WHERE id = ${hiveId}::uuid LIMIT 1
  `;
  return Boolean(row);
}

export async function requireStrictHiveTarget(
  db: QuerySql,
  user: Pick<AuthenticatedApiUser, "id" | "isSystemOwner">,
  source: StrictHiveTargetSource,
  options: { mode?: StrictHiveTargetMode; label?: string } = {},
): Promise<StrictHiveTargetResult> {
  const label = options.label ?? source.key ?? "hiveId";
  const hiveId = normalizeTarget(readHiveTarget(source));
  if (!hiveId) {
    return { ok: false, response: jsonError(`${label} is required`, 400) };
  }

  if (!HIVE_TARGET_UUID_RE.test(hiveId)) {
    return { ok: false, response: jsonError(`${label} must be a valid UUID`, 400) };
  }

  if (!(await hiveExists(db, hiveId))) {
    return { ok: false, response: jsonError("Hive not found", 404) };
  }

  const mode = options.mode ?? "access";
  if (user.isSystemOwner) {
    return { ok: true, hiveId };
  }

  const allowed = mode === "mutate"
    ? await canMutateHive(db as Sql, user.id, hiveId)
    : await canAccessHive(db as Sql, user.id, hiveId);

  if (!allowed) {
    return {
      ok: false,
      response: jsonError(
        mode === "mutate"
          ? "Forbidden: caller cannot manage this hive"
          : "Forbidden: caller cannot access this hive",
        403,
      ),
    };
  }

  return { ok: true, hiveId };
}

export function requireHiveTargetMatchesPath(
  source: StrictHiveTargetSource,
  pathHiveId: string,
  options: { label?: string } = {},
): ResourceOwnershipResult {
  const label = options.label ?? source.key ?? "hiveId";
  const suppliedHiveId = normalizeTarget(readHiveTarget(source));
  if (!suppliedHiveId) return { ok: true };
  if (!HIVE_TARGET_UUID_RE.test(suppliedHiveId)) {
    return { ok: false, response: jsonError(`${label} must be a valid UUID`, 400) };
  }
  if (suppliedHiveId !== pathHiveId) {
    return { ok: false, response: jsonError(`${label} must match path hive id`, 400) };
  }
  return { ok: true };
}

export function requireResourceOwnedByHive(
  resourceHiveId: string | null | undefined,
  hiveId: string,
  options: { resourceName?: string } = {},
): ResourceOwnershipResult {
  const resourceName = options.resourceName ?? "Resource";
  if (!resourceHiveId) {
    return { ok: false, response: jsonError(`${resourceName} not found`, 404) };
  }
  if (resourceHiveId !== hiveId) {
    return {
      ok: false,
      response: jsonError(`Forbidden: ${resourceName.toLowerCase()} does not belong to this hive`, 403),
    };
  }
  return { ok: true };
}
