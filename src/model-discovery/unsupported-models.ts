import { canonicalModelIdForAdapter } from "@/model-health/model-identity";

export function isUnsupportedModelDiscoveryCandidate(adapterType: string, modelId: string): boolean {
  const adapter = adapterType.trim().toLowerCase();

  const canonical = canonicalModelIdForAdapter(adapter, modelId).trim().toLowerCase();

  if (adapter === "codex") {
    const adapterLocalId = canonical.replace(/^openai-codex\//, "");
    return ["gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex"].includes(adapterLocalId);
  }

  if (adapter !== "gemini") return false;

  const adapterLocalId = canonical.replace(/^google\//, "");

  return adapterLocalId.includes("preview") || /^gemini-2\.0(?:[-.]|$)/.test(adapterLocalId);
}
