import { requireSystemOwner } from "../../../_lib/auth";
import { jsonError, jsonOk } from "../../../_lib/responses";
import {
  DEFAULT_LOCAL_EMBEDDING,
  detectLocalEmbeddingStatus,
  pullDefaultLocalEmbeddingModel,
  sanitizeError,
} from "@/memory/local-embedding-setup";

export async function POST(request: Request) {
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;

  try {
    const body = await request.json().catch(() => ({})) as { modelName?: string };
    if (body.modelName && body.modelName !== DEFAULT_LOCAL_EMBEDDING.modelName) {
      return jsonError("Unsupported local embedding model; only the HiveWright default is allowlisted", 400);
    }
    const result = await pullDefaultLocalEmbeddingModel();
    const status = await detectLocalEmbeddingStatus();
    return jsonOk({ result, status });
  } catch (err) {
    return jsonError(sanitizeError(err), 503);
  }
}
