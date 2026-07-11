import { canMutateHive } from "@/auth/users";
import {
  importHiveRecordsFromEmail,
  MAX_EMAIL_IMPORT_MESSAGES,
  type ImportEmailRecordInput,
} from "@/hives/records";
import { type HiveKind, normalizeHiveKind } from "@/hives/kind";
import type { NextResponse } from "next/server";
import { type AuthenticatedApiUser, requireApiUser } from "../../../../_lib/auth";
import { sql } from "../../../../_lib/db";
import { jsonError, jsonOk } from "../../../../_lib/responses";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const access = await resolveHiveAccess(params);
  if ("response" in access) return access.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON", 400);
  }

  const parsed = parseEmailImportBody(body);
  if ("error" in parsed) return jsonError(parsed.error, parsed.status);

  try {
    const result = await importHiveRecordsFromEmail(sql, {
      hiveId: access.hive.id,
      hiveKind: access.hive.kind,
      sourceConnector: parsed.sourceConnector,
      messages: parsed.messages,
    });
    return jsonOk(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid email import";
    const status = /limit exceeded|too large/i.test(message) ? 413 : 400;
    return jsonError(message, status);
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
    const canMutate = await canMutateHive(sql, authz.user.id, id);
    if (!canMutate) {
      return { response: jsonError("Forbidden: hive mutation access required", 403) };
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

function parseEmailImportBody(
  body: unknown,
): { sourceConnector: string | null; messages: ImportEmailRecordInput[] } | { error: string; status: number } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "body must be an object", status: 400 };
  }
  const candidate = body as { sourceConnector?: unknown; messages?: unknown };
  if (candidate.sourceConnector !== undefined && candidate.sourceConnector !== null && typeof candidate.sourceConnector !== "string") {
    return { error: "sourceConnector must be a string", status: 400 };
  }
  if (!Array.isArray(candidate.messages)) {
    return { error: "messages must be an array", status: 400 };
  }
  if (candidate.messages.length > MAX_EMAIL_IMPORT_MESSAGES) {
    return { error: `email import message limit exceeded; maximum is ${MAX_EMAIL_IMPORT_MESSAGES} messages`, status: 413 };
  }

  const messages: ImportEmailRecordInput[] = [];
  for (let index = 0; index < candidate.messages.length; index += 1) {
    const message = candidate.messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return { error: `messages[${index}] must be an object`, status: 400 };
    }
    const row = message as Record<string, unknown>;
    if (typeof row.externalId !== "string" || row.externalId.trim() === "") {
      return { error: `messages[${index}].externalId is required`, status: 400 };
    }
    messages.push({
      externalId: row.externalId,
      threadId: stringOrNull(row.threadId),
      messageId: stringOrNull(row.messageId),
      subject: stringOrNull(row.subject),
      from: stringOrNull(row.from),
      to: recipientsOrNull(row.to),
      snippet: stringOrNull(row.snippet),
      bodyText: stringOrNull(row.bodyText),
      receivedAt: stringOrNull(row.receivedAt),
      labels: stringArrayOrEmpty(row.labels),
      metadata: plainObjectOrEmpty(row.metadata),
      raw: plainObjectOrEmpty(row.raw),
    });
  }

  const sourceConnector = typeof candidate.sourceConnector === "string"
    ? candidate.sourceConnector.trim() || null
    : null;

  return {
    sourceConnector,
    messages,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function recipientsOrNull(value: unknown): string | string[] | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  return null;
}

function stringArrayOrEmpty(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function plainObjectOrEmpty(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
