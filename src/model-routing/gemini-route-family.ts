import { canonicalModelIdForAdapter } from "@/model-health/model-identity";

const RETIRED_G1_GEMINI_MODELS = [
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash-lite-preview-09-2025",
  "gemini-2.5-flash-preview-09-2025",
  "gemini-2.5-pro",
  "gemini-3",
  "gemini-3-flash",
  "gemini-3-flash-preview",
  "gemini-3-pro-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-3.1-flash-live-preview",
  "gemini-3.1-pro",
  "gemini-3.1-pro-preview",
] as const;

const CURRENT_SUPPORTED_GEMINI_FALLBACK_MODELS = [
  "gemini-3.1-flash-lite",
  "gemini-3.5",
  "gemini-3.5-flash",
] as const;

const RETIRED_G1_GEMINI_MODEL_IDS = new Set(
  RETIRED_G1_GEMINI_MODELS.map((model) =>
    canonicalModelIdForAdapter("gemini", model).toLowerCase(),
  ),
);

export function retiredGeminiG1ModelIds(): string[] {
  return [...RETIRED_G1_GEMINI_MODELS].map((model) =>
    canonicalModelIdForAdapter("gemini", model),
  );
}

export function supportedAutomaticGeminiFallbackModelNames(): string[] {
  return [...CURRENT_SUPPORTED_GEMINI_FALLBACK_MODELS];
}

export function isRetiredGeminiG1Model(modelId: string): boolean {
  return RETIRED_G1_GEMINI_MODEL_IDS.has(
    canonicalModelIdForAdapter("gemini", modelId).toLowerCase(),
  );
}
