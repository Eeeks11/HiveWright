"use client";

import { useQuery } from "@tanstack/react-query";
import { useHiveContext } from "@/components/hive-context";
import { OutcomeCard } from "@/components/outcomes/outcome-card";
import type { OwnerOutcomeSummary } from "@/outcomes/types";

async function fetchOutcomes(hiveId: string): Promise<OwnerOutcomeSummary[]> {
  const response = await fetch(`/api/outcomes?hiveId=${encodeURIComponent(hiveId)}`);
  if (!response.ok) {
    throw new Error(`Failed to load final outputs (${response.status})`);
  }
  const body = await response.json() as { data?: OwnerOutcomeSummary[] };
  return Array.isArray(body.data) ? body.data : [];
}

export function FinalOutputsPage() {
  const { selected, hives, loading } = useHiveContext();
  const activeHive = selected ?? hives[0] ?? null;
  const hiveId = activeHive?.id ?? null;

  const outcomesQuery = useQuery({
    queryKey: ["owner-outcomes", hiveId],
    enabled: Boolean(hiveId),
    queryFn: () => fetchOutcomes(hiveId as string),
    refetchInterval: 30_000,
  });

  const outcomes = outcomesQuery.data ?? [];

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <p className="text-sm font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Deliverables
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
          Final outputs
        </h1>
        <p className="max-w-3xl text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          Final owner-facing outcomes for {activeHive?.name ?? "the selected hive"}. Task artifacts and intermediate work remain on goal/task audit trails.
        </p>
      </div>

      {loading ? (
        <div className="rounded-lg border border-dashed p-8 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          Loading hive…
        </div>
      ) : !hiveId ? (
        <div className="rounded-lg border border-dashed p-8 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          Select or create a hive to see final outputs.
        </div>
      ) : outcomesQuery.isError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-8 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          Final outputs could not be loaded for this hive.
        </div>
      ) : outcomesQuery.isLoading ? (
        <div className="rounded-lg border border-dashed p-8 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          Loading final outputs…
        </div>
      ) : outcomes.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          <p className="font-medium text-zinc-700 dark:text-zinc-300">No final outputs yet.</p>
          <p className="mt-1">Completed goals for {activeHive?.name ?? "this hive"} will appear here as owner-facing handoffs. Raw task outputs stay in the audit trail.</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {outcomes.map((outcome) => (
            <OutcomeCard key={outcome.id} outcome={outcome} />
          ))}
        </div>
      )}
    </div>
  );
}
