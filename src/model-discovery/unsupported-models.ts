import { canonicalModelIdForAdapter } from "@/model-health/model-identity";
import { isRetiredGeminiG1Model } from "@/model-routing/gemini-route-family";

export function isUnsupportedModelDiscoveryCandidate(adapterType: string, modelId: string): boolean {
  const adapter = adapterType.trim().toLowerCase();
  if (adapter !== "gemini") return false;

  const canonical = canonicalModelIdForAdapter(adapter, modelId).trim().toLowerCase();
  const adapterLocalId = canonical.replace(/^google\//, "");

  return isRetiredGeminiG1Model(canonical) ||
    adapterLocalId.includes("preview") ||
    /^gemini-2\.0(?:[-.]|$)/.test(adapterLocalId);
}
