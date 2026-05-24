"use client";

import Link from "next/link";
import type { OwnerOutcomeRenderMode, OwnerOutcomeSummary } from "@/outcomes/types";

const STATUS_CLASSES: Record<OwnerOutcomeSummary["status"], string> = {
  new: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  accepted: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  needs_revision: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  archived: "bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300",
  converted_to_process_candidate: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
};

const RENDER_LABELS: Record<OwnerOutcomeRenderMode, string> = {
  text: "Text output",
  markdown: "Document",
  html: "Page",
  image: "Image",
  json: "Data output",
  file: "File",
  external_url: "Live URL",
};

function formatStatus(value: OwnerOutcomeSummary["status"]) {
  return value.replace(/_/g, " ");
}

function isExternalUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

export function OutcomeCard({ outcome }: { outcome: OwnerOutcomeSummary }) {
  return <OutcomeCardView outcome={outcome} />;
}

export function OutcomeCardView({
  outcome,
  onReviewAction,
  actionPending = false,
}: {
  outcome: OwnerOutcomeSummary;
  onReviewAction?: (action: OwnerOutcomeSummary["status"]) => void;
  actionPending?: boolean;
}) {
  const goalUrl = `/goals/${outcome.goalId}`;
  const hasPrimaryOutput = Boolean(outcome.primaryOpenUrl);
  const primaryUrl = outcome.primaryOpenUrl ?? goalUrl;
  const primaryTarget = isExternalUrl(primaryUrl) ? "_blank" : undefined;
  const primaryRel = primaryTarget ? "noreferrer noopener" : undefined;
  const reviewUrl = outcome.primaryDetailUrl ?? goalUrl;
  const artifactLabel = outcome.primaryArtifactRenderMode ? RENDER_LABELS[outcome.primaryArtifactRenderMode] : null;

  return (
    <article className="flex h-full flex-col gap-4 rounded-lg border bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
            Final goal output
          </span>
          {artifactLabel && (
            <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-200">
              {artifactLabel}
            </span>
          )}
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${STATUS_CLASSES[outcome.status]}`}>
            {formatStatus(outcome.status)}
          </span>
        </div>
        <h3 className="text-base font-semibold text-zinc-950 dark:text-zinc-50">
          <Link href={reviewUrl} className="hover:underline">
            {outcome.primaryArtifactTitle ?? outcome.goalTitle}
          </Link>
        </h3>
        <p className="line-clamp-3 whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-400">
          {outcome.summary}
        </p>
      </div>

      <div className="space-y-2 text-sm text-zinc-700 dark:text-zinc-300">
        <p>{outcome.whyItMatters}</p>
        <p>{outcome.impactStatement}</p>
        <p className="font-medium">{outcome.recommendedNextAction}</p>
      </div>

      <dl className="space-y-1 text-xs text-zinc-500 dark:text-zinc-400">
        <div>Completed: {new Date(outcome.createdAt).toLocaleString()}</div>
        {outcome.primaryArtifactTitle && (
          <div>Output: {outcome.primaryArtifactTitle}</div>
        )}
        <div>
          Goal/audit: <Link href={goalUrl} className="text-blue-600 hover:underline dark:text-blue-400">{outcome.goalTitle}</Link>
        </div>
        {outcome.evidenceWorkProductIds.length > 0 && (
          <div>{outcome.evidenceWorkProductIds.length} audit artifact{outcome.evidenceWorkProductIds.length === 1 ? "" : "s"}</div>
        )}
      </dl>

      <div className="flex flex-wrap gap-2 border-t pt-3 dark:border-zinc-800">
        <button
          type="button"
          disabled={actionPending}
          onClick={() => onReviewAction?.("accepted")}
          className="inline-flex items-center justify-center rounded-md border px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
        >
          Accept outcome
        </button>
        <button
          type="button"
          disabled={actionPending}
          onClick={() => onReviewAction?.("needs_revision")}
          className="inline-flex items-center justify-center rounded-md border px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
        >
          Needs revision
        </button>
        <button
          type="button"
          disabled={actionPending}
          onClick={() => onReviewAction?.("converted_to_process_candidate")}
          className="inline-flex items-center justify-center rounded-md border px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
        >
          Process candidate
        </button>
        <button
          type="button"
          disabled={actionPending}
          onClick={() => onReviewAction?.("archived")}
          className="inline-flex items-center justify-center rounded-md border px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
        >
          Archive outcome
        </button>
      </div>

      <div className="mt-auto flex flex-wrap gap-2">
        <Link
          href={primaryUrl}
          target={primaryTarget}
          rel={primaryRel}
          className="inline-flex items-center justify-center rounded-md bg-zinc-950 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
        >
          {hasPrimaryOutput ? outcome.primaryActionLabel : "Review final output"}
        </Link>
        {hasPrimaryOutput && (
          <Link
            href={reviewUrl}
            className="inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            Review handoff
          </Link>
        )}
      </div>
    </article>
  );
}
