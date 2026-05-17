export type DeliverableRenderMode = "text" | "markdown" | "html" | "image" | "json" | "file" | "external_url";

export type DeliverableReviewStatus = "ready" | "needs_review" | "approved" | "rejected" | "archived";

export interface DeliverableSummary {
  id: string;
  hiveId: string;
  taskId: string;
  goalId: string | null;
  title: string;
  summary: string | null;
  filename: string;
  mimeType: string | null;
  renderMode: DeliverableRenderMode;
  reviewStatus: DeliverableReviewStatus;
  openUrl: string;
  downloadUrl: string | null;
  sourceTaskTitle: string | null;
  sourceGoalTitle: string | null;
  createdAt: string;
}
