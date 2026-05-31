import { canAccessHive, canMutateHive } from "@/auth/users";
import { listReferenceDocumentReviews, processReferenceDocumentReviewJob } from "@/hives/reference-document-review";
import { requireApiUser } from "../../../_lib/auth";
import { sql } from "../../../_lib/db";
import { jsonError, jsonOk } from "../../../_lib/responses";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const access = await ensureHiveAccess(params);
  if ("response" in access) return access.response;
  const reviews = await listReferenceDocumentReviews(sql, access.hive.id);
  return jsonOk({ reviews });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const access = await ensureHiveAccess(params, { requireMutation: true });
  if ("response" in access) return access.response;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON", 400);
  }
  if (body.action !== "process" && body.action !== "retry") return jsonError("unsupported action", 400);
  const reviewJobId = typeof body.reviewJobId === "string" ? body.reviewJobId : "";
  let documentId = typeof body.documentId === "string" ? body.documentId : "";
  const documentText = typeof body.documentText === "string" ? body.documentText : null;
  if (!reviewJobId) return jsonError("reviewJobId is required", 400);
  if (!documentId) {
    const [job] = await sql<{ document_id: string }[]>`
      SELECT document_id
      FROM hive_reference_document_review_jobs
      WHERE id = ${reviewJobId}::uuid AND hive_id = ${access.hive.id}::uuid
      LIMIT 1
    `;
    documentId = job?.document_id ?? "";
  }
  if (!documentId) return jsonError("documentId is required", 400);
  const proposals = await processReferenceDocumentReviewJob(sql, {
    hiveId: access.hive.id,
    documentId,
    reviewJobId,
    documentText,
  });
  return jsonOk({ proposals });
}

async function ensureHiveAccess(paramsPromise: Promise<{ id: string }>, options: { requireMutation?: boolean } = {}) {
  const authz = await requireApiUser();
  if ("response" in authz) return { response: authz.response } as const;
  const { id } = await paramsPromise;
  if (!id) return { response: jsonError("hive id is required", 400) } as const;
  const [hive] = await sql<{ id: string }[]>`SELECT id FROM hives WHERE id = ${id} LIMIT 1`;
  if (!hive) return { response: jsonError("hive not found", 404) } as const;
  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, id);
    if (!hasAccess) return { response: jsonError("Forbidden: hive access required", 403) } as const;
    if (options.requireMutation) {
      const canMutate = await canMutateHive(sql, authz.user.id, id);
      if (!canMutate) return { response: jsonError("Forbidden: hive mutation access required", 403) } as const;
    }
  }
  return { user: authz.user, hive } as const;
}
