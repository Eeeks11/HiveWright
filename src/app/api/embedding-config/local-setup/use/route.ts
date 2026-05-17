import { sql } from "../../../_lib/db";
import { requireSystemOwner } from "../../../_lib/auth";
import { jsonError, jsonOk } from "../../../_lib/responses";
import { serializeEmbeddingConfig, resetEmbeddingConfigCache } from "@/memory/embedding-config";
import { saveEmbeddingConfigAndRequestReembed, startEmbeddingReembedInBackground } from "@/memory/reembed";
import {
  DEFAULT_LOCAL_EMBEDDING,
  detectLocalEmbeddingStatus,
  sanitizeError,
  testLocalEmbedding,
} from "@/memory/local-embedding-setup";

export async function POST(request: Request) {
  void request;
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;

  try {
    const status = await detectLocalEmbeddingStatus();
    if (!status.ollamaReachable) {
      return jsonError(status.error ?? "Local Ollama is not reachable", 409);
    }
    if (!status.modelInstalled) {
      return jsonError(`Local embedding model ${DEFAULT_LOCAL_EMBEDDING.modelName} is not installed`, 409);
    }
    const test = await testLocalEmbedding();
    if (test.embeddingTest !== "passed") {
      return jsonError(test.error ?? "Local embedding test failed", 409);
    }

    const [current] = await sql`
      SELECT status
      FROM embedding_config
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `;
    if (current && String(current.status) === "reembedding") {
      return jsonError("A re-embed run is already in progress", 409);
    }

    const persisted = await saveEmbeddingConfigAndRequestReembed({
      provider: DEFAULT_LOCAL_EMBEDDING.provider,
      modelName: DEFAULT_LOCAL_EMBEDDING.modelName,
      dimension: DEFAULT_LOCAL_EMBEDDING.dimension,
      apiCredentialKey: null,
      endpointOverride: DEFAULT_LOCAL_EMBEDDING.endpoint,
      updatedBy: authz.user.email,
    }, sql);

    resetEmbeddingConfigCache();
    if (persisted.reembedRequested && process.env.VITEST !== "true") {
      startEmbeddingReembedInBackground({ sql, configId: persisted.config.id });
    }

    return jsonOk({
      config: {
        ...serializeEmbeddingConfig(persisted.config),
        progress: {
          processed: persisted.config.reembedProcessed,
          total: persisted.config.reembedTotal,
          failed: 0,
          cursor: persisted.config.lastReembeddedId,
          errorSummary: null,
        },
      },
      reembedRequested: persisted.reembedRequested,
    });
  } catch (err) {
    return jsonError(sanitizeError(err), 500);
  }
}
