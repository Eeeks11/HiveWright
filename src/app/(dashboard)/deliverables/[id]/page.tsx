import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/app/api/_lib/db";
import { CopyLinkButton } from "@/components/deliverables/copy-link-button";
import { DeliverablePreview } from "@/components/deliverables/deliverable-preview";
import { getDeliverable } from "@/deliverables/queries";

export const dynamic = "force-dynamic";

function formatStatus(value: string) {
  return value.replace(/_/g, " ");
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="grid gap-1 border-b py-3 last:border-b-0 sm:grid-cols-3 sm:gap-4 dark:border-zinc-800">
      <dt className="text-sm font-medium text-zinc-500">{label}</dt>
      <dd className="text-sm text-zinc-900 sm:col-span-2 dark:text-zinc-100">{value}</dd>
    </div>
  );
}

export default async function DeliverableDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deliverable = await getDeliverable(sql, id);
  if (!deliverable) notFound();

  const openUrl = deliverable.renderMode === "external_url" ? deliverable.openUrl : `/deliverables/${deliverable.id}/open`;
  const reviewUrl = `/deliverables/${deliverable.id}`;

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <Link href="/deliverables" className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
          &larr; Deliverables
        </Link>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium capitalize text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
                {deliverable.renderMode.replace(/_/g, " ")}
              </span>
              <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium capitalize text-blue-800 dark:bg-blue-950 dark:text-blue-200">
                {formatStatus(deliverable.reviewStatus)}
              </span>
            </div>
            <h1 className="text-2xl font-semibold">{deliverable.title}</h1>
            {deliverable.summary && <p className="max-w-3xl whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-400">{deliverable.summary}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href={openUrl}
              target={deliverable.renderMode === "external_url" ? "_blank" : undefined}
              rel={deliverable.renderMode === "external_url" ? "noreferrer" : undefined}
              className="inline-flex items-center justify-center rounded-md bg-zinc-950 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
            >
              Open full page
            </Link>
            {deliverable.downloadUrl && (
              <Link href={deliverable.downloadUrl} className="inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
                Download
              </Link>
            )}
            <Link href={deliverable.openUrl} className="inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
              Raw
            </Link>
            <CopyLinkButton href={reviewUrl} label="Copy review link" />
          </div>
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">Preview</h2>
        <DeliverablePreview deliverable={deliverable} />
      </section>

      <section className="rounded-lg border px-4 dark:border-zinc-800">
        <dl>
          <Detail label="Source task" value={<Link href={`/tasks/${deliverable.taskId}`} className="text-blue-600 hover:underline dark:text-blue-400">{deliverable.sourceTaskTitle ?? deliverable.taskId}</Link>} />
          <Detail label="Source goal" value={deliverable.goalId ? <Link href={`/goals/${deliverable.goalId}`} className="text-blue-600 hover:underline dark:text-blue-400">{deliverable.sourceGoalTitle ?? deliverable.goalId}</Link> : null} />
          <Detail label="Filename" value={<span className="break-all">{deliverable.filename}</span>} />
          <Detail label="MIME type" value={deliverable.mimeType} />
          <Detail label="Created" value={new Date(deliverable.createdAt).toLocaleString()} />
          <Detail label="Source URL" value={deliverable.sourceUrl ? <span className="break-all">{deliverable.sourceUrl}</span> : null} />
        </dl>
      </section>
    </div>
  );
}
