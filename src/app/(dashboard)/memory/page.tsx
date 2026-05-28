"use client";

import { useEffect, useState } from "react";
import { useHiveContext } from "@/components/hive-context";
import { RunsTable, type RunsTableBadgeTone, type RunsTableRow } from "@/components/runs-table";

type MemoryResult = {
  id: string;
  store: "role_memory" | "hive_memory" | "insights";
  content: string;
  confidence: number | null;
  sensitivity: string | null;
  updated_at: string;
};

type MemoryGovernance = {
  hiveId: string;
  memoryEnabled: boolean;
  reason: string | null;
  changedBy: string | null;
  updatedAt: string | null;
  status: {
    enabled: boolean;
    disabled: boolean;
    blocked: boolean;
    recentlyUsed: boolean;
    labels: string[];
  };
  activity: {
    lastUsedAt: string | null;
    lastWriteAt: string | null;
    lastBlockedAt: string | null;
    lastBlockedOperation: string | null;
    lastBlockedSource: string | null;
  };
  counts: {
    roleMemory: number;
    hiveMemory: number;
    deletedRoleMemory: number;
    deletedHiveMemory: number;
  };
  scopeLabel: string;
};

const STORE_TONE: Record<string, RunsTableBadgeTone> = {
  role_memory: "blue",
  hive_memory: "blue",
  insights: "amber",
};

function formatTimestamp(value: string | null) {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

export default function MemoryPage() {
  const { selected, loading: bizLoading } = useHiveContext();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MemoryResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [governance, setGovernance] = useState<MemoryGovernance | null>(null);
  const [governanceLoading, setGovernanceLoading] = useState(false);
  const [governanceError, setGovernanceError] = useState<string | null>(null);
  const [togglePending, setTogglePending] = useState(false);
  const [deletePendingId, setDeletePendingId] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;

    const loadGovernance = async () => {
      setGovernanceLoading(true);
      setGovernanceError(null);
      try {
        const res = await fetch(`/api/hives/${selected.id}/memory-governance`);
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? "Failed to load memory status");
        if (!cancelled) setGovernance(body.data ?? null);
      } catch (err) {
        if (!cancelled) {
          setGovernanceError(err instanceof Error ? err.message : "Unknown error");
        }
      } finally {
        if (!cancelled) setGovernanceLoading(false);
      }
    };

    void loadGovernance();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;

    setLoading(true);
    setError(null);
    setSearched(false);

    try {
      const url = new URL("/api/memory/search", window.location.origin);
      url.searchParams.set("hiveId", selected.id);
      if (query.trim()) url.searchParams.set("q", query.trim());

      const res = await fetch(url.toString());
      if (!res.ok) throw new Error("Search failed");

      const data = await res.json();
      setResults(data.data ?? []);
      setSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function toggleMemoryGovernance() {
    if (!selected || !governance) return;
    setTogglePending(true);
    setGovernanceError(null);
    try {
      const res = await fetch(`/api/hives/${selected.id}/memory-governance`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: !governance.memoryEnabled,
          reason: governance.memoryEnabled ? "Paused from memory dashboard" : undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Failed to update memory status");
      setGovernance(body.data ?? null);
    } catch (err) {
      setGovernanceError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setTogglePending(false);
    }
  }

  async function deleteMemoryEntry(entry: MemoryResult) {
    if (entry.store === "insights") return;
    setDeletePendingId(entry.id);
    setError(null);
    try {
      const res = await fetch("/api/memory/entries", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: entry.id,
          store: entry.store,
          reason: "Removed from memory dashboard",
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Failed to delete memory entry");
      setResults((current) => current.filter((item) => item.id !== entry.id));
      if (selected) {
        const governanceRes = await fetch(`/api/hives/${selected.id}/memory-governance`);
        const governanceBody = await governanceRes.json();
        if (governanceRes.ok) setGovernance(governanceBody.data ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setDeletePendingId(null);
    }
  }

  if (bizLoading) return <p className="text-zinc-400">Loading...</p>;
  if (!selected) return <p className="text-zinc-400">No hive selected.</p>;

  const rows: RunsTableRow[] = results.map((item) => ({
    id: item.id,
    title: item.content,
    status: {
      label: item.store.replace("_", " "),
      tone: STORE_TONE[item.store] ?? "neutral",
    },
    primaryMeta: [
      {
        label: "Sensitivity",
        value: item.sensitivity ?? "standard",
      },
    ],
    secondaryMeta: [
      ...(item.confidence !== null
        ? [{ label: "Confidence", value: `${(item.confidence * 100).toFixed(0)}%` }]
        : []),
      { label: "Updated", value: new Date(item.updated_at).toLocaleDateString() },
    ],
    action: item.store === "insights" ? null : (
      <button
        type="button"
        disabled={deletePendingId === item.id}
        onClick={(event) => {
          event.stopPropagation();
          void deleteMemoryEntry(item);
        }}
        className="rounded-md border border-red-200 px-2.5 py-1 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950"
      >
        {deletePendingId === item.id ? "Removing..." : "Soft delete"}
      </button>
    ),
    expandedContent: (
      <p className="text-sm whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">{item.content}</p>
    ),
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Memory Search</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Search across role memory, hive memory, and insights. Runtime reuse and automatic writes stay scoped to the selected hive.
        </p>
      </div>

      <section className="rounded-xl border border-zinc-200 bg-zinc-50/80 p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/40">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="space-y-2">
            <h2 className="text-lg font-medium">Memory governance status</h2>
            <p className="text-sm text-zinc-500">
              {governance?.scopeLabel ?? "Scope: same-hive agent memory reuse and automatic writes only."}
            </p>
            <div className="flex flex-wrap gap-2">
              {(governance?.status.labels ?? ["loading"]).map((label) => (
                <span
                  key={label}
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    label === "enabled"
                      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                      : label === "disabled"
                        ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                        : label === "blocked"
                          ? "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-200"
                          : "bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-200"
                  }`}
                >
                  {label}
                </span>
              ))}
            </div>
          </div>
          <button
            type="button"
            disabled={togglePending || governanceLoading || !governance}
            onClick={() => { void toggleMemoryGovernance(); }}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
              governance?.memoryEnabled
                ? "bg-red-600 text-white hover:bg-red-500"
                : "bg-emerald-600 text-white hover:bg-emerald-500"
            }`}
          >
            {togglePending
              ? "Updating..."
              : governance?.memoryEnabled
                ? "Disable memory"
                : "Enable memory"}
          </button>
        </div>

        {governanceLoading ? (
          <p className="mt-4 text-sm text-zinc-500">Loading memory status...</p>
        ) : governance ? (
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-lg border bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="text-xs uppercase tracking-wide text-zinc-500">Active entries</p>
              <p className="mt-1 text-lg font-semibold">
                {governance.counts.roleMemory + governance.counts.hiveMemory}
              </p>
              <p className="text-xs text-zinc-500">
                {governance.counts.roleMemory} role, {governance.counts.hiveMemory} hive
              </p>
            </div>
            <div className="rounded-lg border bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="text-xs uppercase tracking-wide text-zinc-500">Soft deleted</p>
              <p className="mt-1 text-lg font-semibold">
                {governance.counts.deletedRoleMemory + governance.counts.deletedHiveMemory}
              </p>
              <p className="text-xs text-zinc-500">
                {governance.counts.deletedRoleMemory} role, {governance.counts.deletedHiveMemory} hive
              </p>
            </div>
            <div className="rounded-lg border bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="text-xs uppercase tracking-wide text-zinc-500">Last reuse</p>
              <p className="mt-1 text-sm font-medium">{formatTimestamp(governance.activity.lastUsedAt)}</p>
              <p className="text-xs text-zinc-500">Last write: {formatTimestamp(governance.activity.lastWriteAt)}</p>
            </div>
            <div className="rounded-lg border bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="text-xs uppercase tracking-wide text-zinc-500">Last blocked</p>
              <p className="mt-1 text-sm font-medium">{formatTimestamp(governance.activity.lastBlockedAt)}</p>
              <p className="text-xs text-zinc-500">
                {governance.activity.lastBlockedOperation ?? "No blocked operation"}
                {governance.activity.lastBlockedSource ? ` via ${governance.activity.lastBlockedSource}` : ""}
              </p>
            </div>
          </div>
        ) : null}

        {(governance?.reason || governanceError) && (
          <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-300">
            {governanceError ?? `Reason: ${governance?.reason}`}
          </p>
        )}
      </section>

      <form onSubmit={handleSearch} className="flex gap-3 items-end flex-wrap">
        {/* Search input */}
        <div className="flex-1 min-w-48 space-y-1">
          <label htmlFor="query" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Search
          </label>
          <input
            id="query"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Leave blank to show all..."
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder-zinc-500"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {loading ? "Searching..." : "Search"}
        </button>
      </form>

      {/* Error */}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Results */}
      {searched && (
        <div className="space-y-3">
          <p className="text-sm text-zinc-500">{results.length} result{results.length !== 1 ? "s" : ""}</p>

          <RunsTable
            rows={rows}
            emptyState="No memory entries found."
            ariaLabel="Memory entries"
            columns={{
              title: "Entry",
              primaryMeta: "Sensitivity",
              status: "Store",
              priority: "",
              secondaryMeta: "Signals",
            }}
          />
        </div>
      )}
    </div>
  );
}
