import { canonicalModelIdForAdapter } from "@/model-health/model-identity";

export function isUnsupportedModelDiscoveryCandidate(adapterType: string, modelId: string): boolean {
  const adapter = adapterType.trim().toLowerCase();
  if (adapter !== "gemini") return false;

  const canonical = canonicalModelIdForAdapter(adapter, modelId).trim().toLowerCase();
  const adapterLocalId = canonical.replace(/^google\//, "");

  return adapterLocalId.includes("preview") || /^gemini-2\.0(?:[-.]|$)/.test(adapterLocalId);
}
