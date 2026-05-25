import { requireApiAuth } from "../../_lib/auth";
import { jsonError, jsonOk } from "../../_lib/responses";
import {
  DEFAULT_LOCAL_EMBEDDING,
  detectLocalEmbeddingStatus,
  getLocalEmbeddingInstallPlan,
  testLocalEmbedding,
} from "@/memory/local-embedding-setup";

export async function GET() {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  try {
    const detected = await detectLocalEmbeddingStatus();
    const status = detected.ollamaReachable && detected.modelInstalled
      ? await testLocalEmbedding()
      : detected;
    return jsonOk({
      status,
      plan: getLocalEmbeddingInstallPlan(status.platform),
      defaultConfig: {
        provider: DEFAULT_LOCAL_EMBEDDING.provider,
        modelName: DEFAULT_LOCAL_EMBEDDING.modelName,
        dimension: DEFAULT_LOCAL_EMBEDDING.dimension,
        endpointOverride: DEFAULT_LOCAL_EMBEDDING.endpoint,
        apiCredentialKey: null,
      },
    });
  } catch (err) {
    console.error("[embedding-config local-setup GET] failed:", err);
    return jsonError("Failed to load local embedding setup status", 500);
  }
}
