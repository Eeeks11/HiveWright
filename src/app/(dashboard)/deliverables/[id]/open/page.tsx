import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/app/api/_lib/db";
import { DeliverablePreview } from "@/components/deliverables/deliverable-preview";
import { getDeliverable } from "@/deliverables/queries";

export const dynamic = "force-dynamic";

export default async function DeliverableOpenPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deliverable = await getDeliverable(sql, id);
  if (!deliverable) notFound();

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <Link href={`/deliverables/${deliverable.id}`} className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
            &larr; Review details
          </Link>
          <h1 className="truncate text-xl font-semibold">{deliverable.title}</h1>
        </div>
        {deliverable.downloadUrl && (
          <Link href={deliverable.downloadUrl} className="inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
            Download
          </Link>
        )}
      </div>
      <DeliverablePreview deliverable={deliverable} />
    </div>
  );
}
