import Link from "next/link";
import type { DeliverableSummary } from "@/deliverables/types";
import { CopyLinkButton } from "./copy-link-button";

const RENDER_LABELS: Record<DeliverableSummary["renderMode"], string> = {
  text: "Text",
  markdown: "Markdown",
  html: "HTML",
  image: "Image",
  json: "JSON",
  file: "File",
  external_url: "External",
};

const REVIEW_CLASSES: Record<DeliverableSummary["reviewStatus"], string> = {
  ready: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  needs_review: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  rejected: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  archived: "bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300",
};

function formatStatus(value: string) {
  return value.replace(/_/g, " ");
}

export function DeliverableCard({ deliverable }: { deliverable: DeliverableSummary }) {
  const reviewUrl = `/deliverables/${deliverable.id}`;
  const openUrl = deliverable.renderMode === "external_url" ? deliverable.openUrl : `${reviewUrl}/open`;

  return (
    <article className="flex h-full flex-col gap-4 rounded-lg border bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
            {RENDER_LABELS[deliverable.renderMode]}
          </span>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${REVIEW_CLASSES[deliverable.reviewStatus]}`}>
            {formatStatus(deliverable.reviewStatus)}
          </span>
        </div>
        <h3 className="text-base font-semibold text-zinc-950 dark:text-zinc-50">
          <Link href={reviewUrl} className="hover:underline">
            {deliverable.title}
          </Link>
        </h3>
        {deliverable.summary && (
          <p className="line-clamp-3 whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-400">
            {deliverable.summary}
          </p>
        )}
      </div>

      <dl className="space-y-1 text-xs text-zinc-500 dark:text-zinc-400">
        <div>Created: {new Date(deliverable.createdAt).toLocaleString()}</div>
        {deliverable.sourceTaskTitle && (
          <div>
            Task: <Link href={`/tasks/${deliverable.taskId}`} className="text-blue-600 hover:underline dark:text-blue-400">{deliverable.sourceTaskTitle}</Link>
          </div>
        )}
        {deliverable.goalId && deliverable.sourceGoalTitle && (
          <div>
            Goal: <Link href={`/goals/${deliverable.goalId}`} className="text-blue-600 hover:underline dark:text-blue-400">{deliverable.sourceGoalTitle}</Link>
          </div>
        )}
        {deliverable.filename && <div className="break-all">File: {deliverable.filename}</div>}
      </dl>

      <div className="mt-auto flex flex-wrap gap-2">
        <Link
          href={openUrl}
          target={deliverable.renderMode === "external_url" ? "_blank" : undefined}
          rel={deliverable.renderMode === "external_url" ? "noreferrer" : undefined}
          className="inline-flex items-center justify-center rounded-md bg-zinc-950 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
        >
          Open
        </Link>
        {deliverable.downloadUrl && (
          <Link
            href={deliverable.downloadUrl}
            className="inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            Download
          </Link>
        )}
        <CopyLinkButton href={reviewUrl} />
      </div>
    </article>
  );
}
