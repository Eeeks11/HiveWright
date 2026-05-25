import { canAccessHive } from "@/auth/users";
import {
  createManualHiveRecord,
  getHiveRecordOptions,
  listRecentHiveRecords,
} from "@/hives/records";
import { type HiveKind, normalizeHiveKind } from "@/hives/kind";
import type { NextResponse } from "next/server";
import { type AuthenticatedApiUser, requireApiUser } from "../../../_lib/auth";
import { sql } from "../../../_lib/db";
import { jsonError, jsonOk } from "../../../_lib/responses";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const access = await resolveHiveAccess(params);
  if ("response" in access) return access.response;

  const limit = limitFromUrl(request.url);
  const records = await listRecentHiveRecords(sql, access.hive.id, {
    limit,
    hiveKind: access.hive.kind,
  });
  const options = getHiveRecordOptions(access.hive.kind);

  return jsonOk({ records, options });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const access = await resolveHiveAccess(params);
  if ("response" in access) return access.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON", 400);
  }

  if (typeof body.title !== "string" || body.title.trim() === "") {
    return jsonError("title is required", 400);
  }

  try {
    const record = await createManualHiveRecord(sql, {
      hiveId: access.hive.id,
      hiveKind: access.hive.kind,
      family: stringOrNull(body.family),
      type: stringOrNull(body.type),
      title: body.title,
      occurredAt: stringOrNull(body.occurredAt),
      amountCents: amountCentsFromBody(body),
      currency: stringOrNull(body.currency),
      counterparty: stringOrNull(body.counterparty),
      status: stringOrNull(body.status),
      summary: stringOrNull(body.summary),
      notes: stringOrNull(body.notes),
      metadata: plainObjectOrEmpty(body.metadata),
      raw: plainObjectOrEmpty(body.raw),
    });
    return jsonOk(record, 201);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "invalid hive record", 400);
  }
}

type HiveAccess =
  | { response: NextResponse }
  | { user: AuthenticatedApiUser; hive: { id: string; kind: HiveKind } };

async function resolveHiveAccess(paramsPromise: Promise<{ id: string }>): Promise<HiveAccess> {
  const authz = await requireApiUser();
  if ("response" in authz) return { response: authz.response };

  const { id } = await paramsPromise;
  if (!id) return { response: jsonError("hive id is required", 400) };

  const [hive] = await sql<{ id: string; kind: string | null }[]>`
    SELECT id, kind FROM hives WHERE id = ${id}
  `;
  if (!hive) return { response: jsonError("hive not found", 404) };

  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, id);
    if (!hasAccess) {
      return { response: jsonError("Forbidden: hive access required", 403) };
    }
  }

  return {
    user: authz.user,
    hive: {
      id: hive.id,
      kind: normalizeHiveKind(hive.kind),
    },
  };
}

function limitFromUrl(url: string): number {
  const raw = new URL(url).searchParams.get("limit");
  const parsed = raw ? Number.parseInt(raw, 10) : 25;
  if (!Number.isFinite(parsed)) return 25;
  return Math.min(Math.max(parsed, 1), 100);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function plainObjectOrEmpty(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function amountCentsFromBody(body: Record<string, unknown>): number | null {
  if (typeof body.amountCents === "number") return body.amountCents;
  if (typeof body.amount === "number") return Math.round(body.amount * 100);
  if (typeof body.amount === "string" && body.amount.trim()) {
    const parsed = Number(body.amount);
    if (!Number.isFinite(parsed)) throw new Error("amount must be numeric");
    return Math.round(parsed * 100);
  }
  return null;
}
