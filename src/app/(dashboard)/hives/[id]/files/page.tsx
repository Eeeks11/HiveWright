"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Check, Download, ExternalLink, FileText, FolderOpen, RotateCw, X } from "lucide-react";
import { HiveSectionNav } from "@/components/hive-section-nav";

const CATEGORIES = [
  { id: "projects", label: "Projects" },
  { id: "work-products", label: "Work Products" },
  { id: "attachments", label: "Attachments" },
  { id: "reference-documents", label: "Reference Documents" },
  { id: "generated-docs", label: "Generated Docs" },
  { id: "ea-files", label: "EA Files" },
] as const;

type CategoryId = (typeof CATEGORIES)[number]["id"];

type FileItem = {
  id: string;
  name: string;
  category: CategoryId;
  source: "filesystem" | "database";
  relativePath: string;
  location: string;
  sizeBytes: number | null;
  createdAt: string | null;
  modifiedAt: string | null;
  type: string;
  extension: string;
  mimeType: string | null;
  previewable: boolean;
  downloadable: boolean;
  previewUrl: string | null;
  downloadUrl: string | null;
};

type ReviewProposal = {
  id: string;
  title: string;
  summary: string | null;
  proposedCategory: string;
  proposedRecordType: string;
  confidence: number | null;
  sourceExcerpt: string | null;
  suggestedStatus: string;
  decision: string;
};

type ReviewJob = {
  id: string;
  documentId: string;
  status: string;
  error: string | null;
  document: { filename: string; relativePath: string };
  proposals: ReviewProposal[];
};

type PreviewState =
  | { status: "idle"; item: null; content: ""; contentType: ""; error: "" }
  | { status: "loading"; item: FileItem; content: ""; contentType: ""; error: "" }
  | { status: "ready"; item: FileItem; content: string; contentType: string; error: "" }
  | { status: "error"; item: FileItem; content: ""; contentType: ""; error: string };

function formatBytes(size: number | null): string {
  if (size === null) return "Unknown size";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

function formatDate(value: string | null): string {
  if (!value) return "No timestamp";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No timestamp";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderPreview(content: string, contentType: string) {
  if (contentType === "application/json") {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return content;
    }
  }
  return content;
}

export default function HiveFilesPage() {
  const params = useParams<{ id: string }>();
  const hiveId = params.id;
  const [activeCategory, setActiveCategory] = useState<CategoryId>("projects");
  const [items, setItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reviews, setReviews] = useState<ReviewJob[]>([]);
  const [reviewAction, setReviewAction] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({
    status: "idle",
    item: null,
    content: "",
    contentType: "",
    error: "",
  });

  useEffect(() => {
    let cancelled = false;
    async function loadFiles() {
      setLoading(true);
      setError("");
      setPreview({ status: "idle", item: null, content: "", contentType: "", error: "" });
      try {
        const res = await fetch(`/api/hives/${hiveId}/files?category=${activeCategory}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "Failed to load files.");
        if (!cancelled) setItems(body.data?.items ?? []);
      } catch (err) {
        if (!cancelled) {
          setItems([]);
          setError(err instanceof Error ? err.message : "Failed to load files.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadFiles();
    if (activeCategory === "reference-documents") {
      fetch(`/api/hives/${hiveId}/reference-document-reviews`)
        .then(async (res) => {
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || "Failed to load document reviews.");
          if (!cancelled) setReviews(body.data?.reviews ?? []);
        })
        .catch(() => {
          if (!cancelled) setReviews([]);
        });
    } else {
      setReviews([]);
    }
    return () => {
      cancelled = true;
    };
  }, [activeCategory, hiveId]);

  const selectedCategory = useMemo(
    () => CATEGORIES.find((category) => category.id === activeCategory) ?? CATEGORIES[0],
    [activeCategory],
  );

  async function decideProposal(proposal: ReviewProposal, decision: "accepted" | "edited" | "rejected" | "needs_confirmation") {
    const edits: Record<string, string> = {};
    if (decision === "edited") {
      const title = window.prompt("Record title", proposal.title);
      if (title === null) return;
      const summary = window.prompt("Record summary", proposal.summary ?? "");
      if (summary === null) return;
      edits.title = title;
      edits.summary = summary;
    }
    setReviewAction(proposal.id);
    try {
      const res = await fetch(`/api/hives/${hiveId}/reference-document-reviews/proposals/${proposal.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, edits }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Review action failed.");
      const refreshed = await fetch(`/api/hives/${hiveId}/reference-document-reviews`);
      const refreshedBody = await refreshed.json();
      setReviews(refreshedBody.data?.reviews ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Review action failed.");
    } finally {
      setReviewAction(null);
    }
  }

  async function retryReview(review: ReviewJob) {
    setReviewAction(review.id);
    try {
      const res = await fetch(`/api/hives/${hiveId}/reference-document-reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry", reviewJobId: review.id }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Review retry failed.");
      const refreshed = await fetch(`/api/hives/${hiveId}/reference-document-reviews`);
      const refreshedBody = await refreshed.json();
      setReviews(refreshedBody.data?.reviews ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Review retry failed.");
    } finally {
      setReviewAction(null);
    }
  }

  async function openPreview(item: FileItem) {
    if (!item.previewUrl) return;
    setPreview({ status: "loading", item, content: "", contentType: "", error: "" });
    try {
      const res = await fetch(item.previewUrl);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Preview failed.");
      setPreview({
        status: "ready",
        item,
        content: body.data?.content ?? "",
        contentType: body.data?.contentType ?? "text/plain",
        error: "",
      });
    } catch (err) {
      setPreview({
        status: "error",
        item,
        content: "",
        contentType: "",
        error: err instanceof Error ? err.message : "Preview failed.",
      });
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="hive-honey-glow space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-amber-700/80 dark:text-amber-300/70">Hive files</p>
            <h1 className="text-2xl font-semibold text-amber-950 dark:text-amber-50">Read-only file browser</h1>
          </div>
        </div>
        <HiveSectionNav hiveId={hiveId} />
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="File categories">
        {CATEGORIES.map((category) => {
          const active = category.id === activeCategory;
          return (
            <button
              key={category.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveCategory(category.id)}
              className={`shrink-0 cursor-pointer rounded-md border px-3 py-2 text-sm font-medium ${
                active
                  ? "border-amber-300 bg-amber-200/80 text-amber-950 dark:border-amber-400/40 dark:bg-amber-400/15 dark:text-amber-100"
                  : "border-amber-200/70 bg-white/60 text-amber-900/80 hover:bg-amber-100/70 dark:border-white/[0.08] dark:bg-zinc-950/40 dark:text-zinc-300 dark:hover:bg-white/[0.04]"
              }`}
            >
              {category.label}
            </button>
          );
        })}
      </div>

      <section className="space-y-3">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg font-medium text-amber-950 dark:text-amber-100">{selectedCategory.label}</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{items.length} item{items.length === 1 ? "" : "s"}</p>
        </div>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </div>
        )}

        {loading && <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading files...</p>}

        {!loading && !error && items.length === 0 && (
          <div className="rounded-md border border-dashed border-amber-200/80 p-6 text-sm text-zinc-500 dark:border-white/[0.08] dark:text-zinc-400">
            No files found for this category.
          </div>
        )}



        {activeCategory === "reference-documents" && reviews.length > 0 && (
          <div className="space-y-3 rounded-md border border-amber-200/70 bg-white/70 p-4 dark:border-white/[0.08] dark:bg-zinc-950/50">
            <div>
              <h3 className="text-sm font-semibold text-amber-950 dark:text-amber-100">Reference document review</h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">AI-extracted proposals are untrusted until accepted here.</p>
            </div>
            {reviews.map((review) => (
              <div key={review.id} className="space-y-2 rounded-md border border-amber-100 p-3 dark:border-white/[0.08]">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium text-zinc-950 dark:text-zinc-100">{review.document.filename}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">Status: {review.status.replaceAll("_", " ")}</p>
                  </div>
                  {review.status === "processing" || review.status === "extracting" ? <RotateCw className="size-4 animate-spin text-amber-500" aria-hidden="true" /> : null}
                  {review.status === "failed" && (
                    <button type="button" disabled={reviewAction === review.id} onClick={() => retryReview(review)} className="inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50">
                      <RotateCw className="size-3" aria-hidden="true" /> Retry
                    </button>
                  )}
                </div>
                {review.error && <p className="text-xs text-red-600 dark:text-red-300">{review.error}</p>}
                {review.proposals.length === 0 && !review.error && (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">No proposals yet.</p>
                )}
                {review.proposals.map((proposal) => (
                  <div key={proposal.id} className="space-y-2 rounded-md bg-amber-50/70 p-3 text-sm dark:bg-white/[0.03]">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className="font-medium text-zinc-950 dark:text-zinc-100">{proposal.title}</p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">{proposal.proposedCategory} · {proposal.suggestedStatus.replaceAll("_", " ")} · decision: {proposal.decision}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" disabled={reviewAction === proposal.id || proposal.decision !== "pending"} onClick={() => decideProposal(proposal, "accepted")} className="inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50">
                          <Check className="size-3" aria-hidden="true" /> Accept
                        </button>
                        <button type="button" disabled={reviewAction === proposal.id || proposal.decision !== "pending"} onClick={() => decideProposal(proposal, "edited")} className="inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50">
                          Edit then accept
                        </button>
                        <button type="button" disabled={reviewAction === proposal.id || proposal.decision !== "pending"} onClick={() => decideProposal(proposal, "needs_confirmation")} className="inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50">
                          Mark needs confirmation
                        </button>
                        <button type="button" disabled={reviewAction === proposal.id || proposal.decision !== "pending"} onClick={() => decideProposal(proposal, "rejected")} className="inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50">
                          <X className="size-3" aria-hidden="true" /> Reject
                        </button>
                      </div>
                    </div>
                    {proposal.summary && <p className="text-zinc-700 dark:text-zinc-300">{proposal.summary}</p>}
                    {proposal.sourceExcerpt && <blockquote className="border-l-2 border-amber-300 pl-3 text-xs text-zinc-500 dark:text-zinc-400">{proposal.sourceExcerpt}</blockquote>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        <div className="grid gap-3">
          {items.map((item) => (
            <article
              key={item.id}
              className="rounded-md border border-amber-200/70 bg-white/70 p-4 dark:border-white/[0.08] dark:bg-zinc-950/50"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-2">
                  <div className="flex items-start gap-2">
                    {item.source === "filesystem" ? (
                      <FolderOpen className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
                    ) : (
                      <FileText className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
                    )}
                    <div className="min-w-0">
                      <h3 className="break-words text-sm font-semibold text-zinc-950 dark:text-zinc-100">{item.name}</h3>
                      <p className="break-all font-mono text-xs text-zinc-500 dark:text-zinc-400">{item.location}</p>
                    </div>
                  </div>
                  <dl className="grid gap-2 text-xs text-zinc-600 dark:text-zinc-300 sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <dt className="font-medium text-zinc-950 dark:text-zinc-100">Type</dt>
                      <dd>{item.type || item.extension || "File"}</dd>
                    </div>
                    <div>
                      <dt className="font-medium text-zinc-950 dark:text-zinc-100">Size</dt>
                      <dd>{formatBytes(item.sizeBytes)}</dd>
                    </div>
                    <div>
                      <dt className="font-medium text-zinc-950 dark:text-zinc-100">Modified</dt>
                      <dd>{formatDate(item.modifiedAt)}</dd>
                    </div>
                    <div>
                      <dt className="font-medium text-zinc-950 dark:text-zinc-100">Source</dt>
                      <dd>{item.source}</dd>
                    </div>
                  </dl>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {item.previewable && (
                    <button
                      type="button"
                      onClick={() => openPreview(item)}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-amber-50 dark:hover:bg-white/[0.04]"
                    >
                      <ExternalLink className="size-3.5" aria-hidden="true" />
                      Preview
                    </button>
                  )}
                  {item.downloadable && item.downloadUrl && (
                    <a
                      href={item.downloadUrl}
                      className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-amber-50 dark:hover:bg-white/[0.04]"
                    >
                      <Download className="size-3.5" aria-hidden="true" />
                      Download
                    </a>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      {preview.item && (
        <section className="space-y-3 rounded-md border border-amber-200/70 bg-amber-50/50 p-4 dark:border-white/[0.08] dark:bg-zinc-950/50">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="break-words text-base font-medium text-amber-950 dark:text-amber-100">
              Preview: {preview.item.name}
            </h2>
            <button
              type="button"
              onClick={() => setPreview({ status: "idle", item: null, content: "", contentType: "", error: "" })}
              className="w-fit cursor-pointer text-sm text-zinc-600 hover:underline dark:text-zinc-300"
            >
              Close
            </button>
          </div>
          {preview.status === "loading" && <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading preview...</p>}
          {preview.status === "error" && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
              {preview.error}
            </p>
          )}
          {preview.status === "ready" && (
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-white p-4 font-mono text-xs leading-relaxed text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
              {renderPreview(preview.content, preview.contentType)}
            </pre>
          )}
        </section>
      )}
    </div>
  );
}
