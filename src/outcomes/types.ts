export type OwnerOutcomeStatus = "unread" | "reviewed" | "accepted" | "changes_requested" | "archived";

export type OwnerOutcomeRenderMode = "text" | "markdown" | "html" | "image" | "json" | "file" | "external_url";

export type OwnerOutcomeSummary = {
  id: string;
  goalId: string;
  hiveId: string;
  goalTitle: string;
  summary: string;
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
