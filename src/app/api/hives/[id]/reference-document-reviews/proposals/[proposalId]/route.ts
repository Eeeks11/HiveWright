import { canAccessHive, canMutateHive } from "@/auth/users";
import { decideReferenceDocumentProposal } from "@/hives/reference-document-review";
import { normalizeHiveKind } from "@/hives/kind";
import { requireApiUser } from "../../../../../_lib/auth";
import { sql } from "../../../../../_lib/db";
import { jsonError, jsonOk } from "../../../../../_lib/responses";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; proposalId: string }> },
) {
  const access = await ensureHiveMutationAccess(params);
  if ("response" in access) return access.response;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON", 400);
  }
  const decision = body.decision;
  if (decision !== "accepted" && decision !== "edited" && decision !== "rejected" && decision !== "needs_confirmation") {
    return jsonError("decision must be accepted, edited, rejected, or needs_confirmation", 400);
  }
  try {
    const result = await decideReferenceDocumentProposal(sql, {
      hiveId: access.hive.id,
      proposalId: access.proposalId,
      decision,
      userId: access.user.id,
      hiveKind: access.hive.kind,
      edits: plainObject(body.edits),
    });
    return jsonOk(result);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "proposal decision failed", 400);
  }
}

async function ensureHiveMutationAccess(paramsPromise: Promise<{ id: string; proposalId: string }>) {
  const authz = await requireApiUser();
  if ("response" in authz) return { response: authz.response } as const;
  const { id, proposalId } = await paramsPromise;
  if (!id || !proposalId) return { response: jsonError("hive id and proposal id are required", 400) } as const;
  const [hive] = await sql<{ id: string; kind: string | null }[]>`SELECT id, kind FROM hives WHERE id = ${id} LIMIT 1`;
  if (!hive) return { response: jsonError("hive not found", 404) } as const;
  if (!authz.user.isSystemOwner) {
    const canRead = await canAccessHive(sql, authz.user.id, id);
    const canMutate = canRead ? await canMutateHive(sql, authz.user.id, id) : false;
    if (!canMutate) return { response: jsonError("Forbidden: hive mutation access required", 403) } as const;
  }
  return { user: authz.user, hive: { id: hive.id, kind: normalizeHiveKind(hive.kind) }, proposalId } as const;
}

function plainObject(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") out[key] = raw;
  }
  return out;
}
