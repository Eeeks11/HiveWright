"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { RunsTable, type RunsTableRow } from "@/components/runs-table";

interface Hive { id: string; name: string; slug: string; type: string; }

export default function HivesPage() {
  const [hives, setHives] = useState<Hive[]>([]);
  const [loading, setLoading] = useState(true);
  const [exportingHiveId, setExportingHiveId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/hives").then(r => r.json()).then(b => setHives(b.data || [])).finally(() => setLoading(false));
  }, []);

  const exportTemplate = async (hive: Hive) => {
    setExportingHiveId(hive.id);
    setExportError(null);
    try {
      const res = await fetch(`/api/hives/${hive.id}/portability/export`);
      const text = await res.text();
      const body = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error(body?.error ?? `Export failed with ${res.status}`);
      const blob = new Blob([`${JSON.stringify(body.data, null, 2)}\n`], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${hive.slug || "hive"}-template.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Failed to export template");
    } finally {
      setExportingHiveId(null);
    }
  };

  const rows: RunsTableRow[] = hives.map((hive) => ({
    id: hive.id,
    title: hive.name,
    href: `/hives/${hive.id}`,
    status: { label: hive.type, tone: "neutral" },
    priority: {
      label: exportingHiveId === hive.id ? "Exporting…" : "Template",
      tone: "amber",
    },
    primaryMeta: [{ label: "Slug", value: <span className="font-mono">{hive.slug}</span> }],
    secondaryMeta: [{ label: "ID", value: <span className="font-mono">{hive.id.slice(0, 8)}</span> }],
    actions: (
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          exportTemplate(hive);
        }}
        disabled={exportingHiveId === hive.id}
        className="rounded-md border border-amber-300/70 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:cursor-wait disabled:opacity-50 dark:border-amber-300/20 dark:text-amber-100 dark:hover:bg-amber-300/10"
      >
        Export Template
      </button>
    ),
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Hives</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/hives/import"
            className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800">
            Import Template
          </Link>
          <Link href="/hives/new"
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200">
            + New Hive
          </Link>
        </div>
      </div>
      <RunsTable
        rows={rows}
        loading={loading}
        loadingState="Loading..."
        emptyState='No hives yet. Click "New Hive" to get started.'
        ariaLabel="Hives list"
        columns={{ title: "Hive", primaryMeta: "Slug", status: "Type", priority: "Template", secondaryMeta: "Actions" }}
      />
      {exportError && (
        <p className="text-sm text-red-600 dark:text-red-400">{exportError}</p>
      )}
    </div>
  );
}
