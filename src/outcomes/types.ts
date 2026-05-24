export type OwnerOutcomeStatus = "new" | "accepted" | "needs_revision" | "archived" | "converted_to_process_candidate";

export type OwnerOutcomeRenderMode = "text" | "markdown" | "html" | "image" | "json" | "file" | "external_url";

export type OwnerOutcomeSummary = {
  id: string;
  goalId: string;
  hiveId: string;
  goalTitle: string;
  summary: string;
  whyItMatters: string;
  recommendedNextAction: string;
  impactStatement: string;
  status: OwnerOutcomeStatus;
  createdAt: string;
  evidenceWorkProductIds: string[];
  primaryWorkProductId: string | null;
  primaryOpenUrl: string | null;
  primaryDetailUrl: string | null;
  primaryArtifactTitle: string | null;
  primaryArtifactRenderMode: OwnerOutcomeRenderMode | null;
  primaryActionLabel: string;
};
