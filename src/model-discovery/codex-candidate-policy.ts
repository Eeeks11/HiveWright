import { canonicalModelIdForAdapter } from "@/model-health/model-identity";

const SUPPORTED_AUTOMATIC_CODEX_MODELS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
] as const;

const SUPPORTED_AUTOMATIC_CODEX_MODEL_IDS = new Set(
  SUPPORTED_AUTOMATIC_CODEX_MODELS.map((model) =>
    canonicalModelIdForAdapter("codex", model).toLowerCase()
  ),
);

export function supportedAutomaticCodexModelIds(): string[] {
  return [...SUPPORTED_AUTOMATIC_CODEX_MODELS].map((model) =>
    canonicalModelIdForAdapter("codex", model)
  );
}

export function isSupportedAutomaticCodexModel(modelId: string): boolean {
  return SUPPORTED_AUTOMATIC_CODEX_MODEL_IDS.has(
    canonicalModelIdForAdapter("codex", modelId).toLowerCase(),
  );
}
