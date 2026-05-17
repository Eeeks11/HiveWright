import Link from "next/link";
import type { DeliverableDetail } from "@/deliverables/queries";

function previewText(deliverable: DeliverableDetail) {
  if (deliverable.content === null) return null;
  if (deliverable.renderMode === "json") {
    try {
      return JSON.stringify(JSON.parse(deliverable.content), null, 2);
    } catch {
      return deliverable.content;
    }
  }
  return deliverable.content;
}

function contentUrl(deliverable: DeliverableDetail) {
  return `/api/deliverables/${deliverable.id}/content`;
}

export function DeliverablePreview({ deliverable }: { deliverable: DeliverableDetail }) {
  if (deliverable.renderMode === "external_url") {
    return (
      <div className="rounded-lg border bg-zinc-50 p-6 text-sm dark:border-zinc-800 dark:bg-zinc-950">
        <p className="text-zinc-600 dark:text-zinc-400">This deliverable is hosted outside HiveWright.</p>
        {deliverable.publicUrl && (
          <Link href={deliverable.publicUrl} target="_blank" rel="noreferrer noopener" className="mt-3 inline-flex text-blue-600 hover:underline dark:text-blue-400">
            Open external deliverable
          </Link>
        )}
      </div>
    );
  }

  if (deliverable.renderMode === "html") {
    return (
      <iframe
        title={deliverable.title}
        src={contentUrl(deliverable)}
        sandbox=""
        className="h-[70vh] min-h-96 w-full rounded-lg border bg-white dark:border-zinc-800"
      />
    );
  }

  if (deliverable.renderMode === "image") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={contentUrl(deliverable)} alt={deliverable.title} className="max-h-[75vh] w-full rounded-lg border object-contain dark:border-zinc-800" />;
  }

  const text = previewText(deliverable);
  if (text !== null && ["text", "markdown", "json"].includes(deliverable.renderMode)) {
    return (
      <pre className="max-h-[70vh] overflow-auto rounded-lg border bg-zinc-50 p-4 text-sm whitespace-pre-wrap text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
        {text}
      </pre>
    );
  }

  return (
    <div className="rounded-lg border bg-zinc-50 p-6 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
      <p>Preview is not available for this file type. Use Open or Download to inspect the deliverable.</p>
    </div>
  );
}
