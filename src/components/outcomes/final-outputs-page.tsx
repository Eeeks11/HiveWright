"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useHiveContext } from "@/components/hive-context";
import { OutcomeCardView } from "@/components/outcomes/outcome-card";
import type { OwnerOutcomeSummary } from "@/outcomes/types";

type OutcomeQueueFilter =
  | "needs_review"
  | "needs_revision"
  | "reusable_ideas"
  | "accepted"
  | "archived"
  | "all";

type ReviewMutationResult = {
  data?: {
    id: string;
    status: OwnerOutcomeSummary["status"];
    revisionTaskId?: string;
  };
};

const QUEUE_FILTERS: Array<{ value: OutcomeQueueFilter; label: string }> = [
  { value: "needs_review", label: "Needs review" },
  { value: "needs_revision", label: "Needs revision" },
  { value: "reusable_ideas", label: "Reusable ideas" },
  { value: "accepted", label: "Accepted" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
];

function queueIncludesOutcome(filter: OutcomeQueueFilter, outcome: OwnerOutcomeSummary) {
  switch (filter) {
    case "needs_review":
      return outcome.status === "new";
    case "needs_revision":
      return outcome.status === "needs_revision";
    case "reusable_ideas":
      return outcome.status === "converted_to_process_candidate";
    case "accepted":
      return outcome.status === "accepted";
    case "archived":
      return outcome.status === "archived";
    case "all":
      return true;
  }
}

function queueEmptyState(filter: OutcomeQueueFilter, hiveName: string | undefined) {
  switch (filter) {
    case "needs_review":
      return `Nothing is waiting on owner review for ${hiveName ?? "this hive"} right now.`;
    case "needs_revision":
      return "No outputs are currently waiting on revision follow-up.";
    case "reusable_ideas":
      return "No reusable ideas have been flagged yet.";
    case "accepted":
      return "No accepted final outputs yet.";
    case "archived":
      return "No archived final outputs yet.";
    case "all":
      return "No final outputs yet.";
  }
}

function reviewSuccessMessage(
  action: OwnerOutcomeSummary["status"],
  result?: { revisionTaskId?: string },
) {
  switch (action) {
    case "accepted":
      return "Final output accepted. It moved to the Accepted queue.";
    case "needs_revision":
      return result?.revisionTaskId
        ? `Revision request saved. Follow-up task ${result.revisionTaskId} is now queued.`
        : "Revision request saved and returned to the work queue.";
    case "converted_to_process_candidate":
      return "Reusable idea saved. No process was created yet.";
    case "archived":
      return "Final output archived. It remains available from the Archived queue.";
    default:
      return null;
  }
}

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
  const queryClient = useQueryClient();
  const [queueFilter, setQueueFilter] = useState<OutcomeQueueFilter>("needs_review");
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);

  const outcomesQuery = useQuery({
    queryKey: ["owner-outcomes", hiveId],
    enabled: Boolean(hiveId),
    queryFn: () => fetchOutcomes(hiveId as string),
    refetchInterval: 30_000,
  });

  const reviewMutation = useMutation({
    mutationFn: async ({
      outcomeId,
      action,
      note,
    }: {
      outcomeId: string;
      action: OwnerOutcomeSummary["status"];
      note?: string;
    }) => {
      const response = await fetch(`/api/outcomes/${encodeURIComponent(outcomeId)}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, note }),
      });
      if (!response.ok) {
        throw new Error(`Failed to update outcome (${response.status})`);
      }
      return response.json() as Promise<ReviewMutationResult>;
    },
    onSuccess: async (result, variables) => {
      queryClient.setQueryData<OwnerOutcomeSummary[]>(
        ["owner-outcomes", hiveId],
        (current) => current?.map((outcome) =>
          outcome.id === variables.outcomeId
            ? { ...outcome, status: result.data?.status ?? variables.action }
            : outcome,
        ) ?? current,
      );
      setFeedbackMessage(reviewSuccessMessage(variables.action, result.data));
      await queryClient.invalidateQueries({ queryKey: ["owner-outcomes", hiveId] });
    },
  });

  const outcomes = outcomesQuery.data ?? [];
  const visibleOutcomes = outcomes.filter((outcome) => queueIncludesOutcome(queueFilter, outcome));

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
          Final owner-facing outcomes for {activeHive?.name ?? "the selected hive"}. The default queue only shows work that still needs owner review; accepted, archived, and reusable items stay available through the queues below.
        </p>
      </div>

      {feedbackMessage && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200">
          {feedbackMessage}
        </div>
      )}

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
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {QUEUE_FILTERS.map((filter) => {
              const active = queueFilter === filter.value;
              const count = outcomes.filter((outcome) => queueIncludesOutcome(filter.value, outcome)).length;
              return (
                <button
                  key={filter.value}
                  type="button"
                  aria-label={filter.label}
                  onClick={() => setQueueFilter(filter.value)}
                  className={`rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                    active
                      ? "border-amber-500 bg-amber-400 text-zinc-950"
                      : "border-amber-200 bg-amber-50 text-amber-950 hover:bg-amber-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
                  }`}
                >
                  {filter.label} <span className="ml-1 text-xs opacity-80">{count}</span>
                </button>
              );
            })}
          </div>

          {visibleOutcomes.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <p className="font-medium text-zinc-700 dark:text-zinc-300">{queueEmptyState(queueFilter, activeHive?.name)}</p>
              <p className="mt-1">Completed goals for {activeHive?.name ?? "this hive"} still remain available in the other Final Outputs queues.</p>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {visibleOutcomes.map((outcome) => (
                <OutcomeCardView
                  key={outcome.id}
                  outcome={outcome}
                  actionPending={reviewMutation.isPending}
                  onReviewAction={(action, note) => {
                    setFeedbackMessage(null);
                    reviewMutation.mutate({ outcomeId: outcome.id, action, note });
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
