"use client";

import { AlertTriangle, ArrowRight, CheckCircle2, CircleDot, Flag } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

type ListItem = {
  id: string;
  title?: string;
  summary?: string;
  status?: string | null;
  priority?: string | null;
  href?: string | null;
  targetLabel?: string | null;
};

type ListSummary = {
  count: number;
  items: ListItem[];
};

type KindMetrics =
  | {
      kind: "business";
      revenueCents: number;
      expensesCents: number;
      leads: number;
      activeCampaigns: number;
      salesPipeline: number;
      profitLossEstimateCents: number;
    }
  | {
      kind: "personal_project";
      milestoneProgress: { completed: number; total: number };
      openBlockers: number;
      deliverablesProduced: number;
      deadlineRisk: string;
    }
  | {
      kind: "personal_assistant";
      openRequests: number;
      overdueReminders: number;
      waitingOnOwnerItems: number;
      sensitiveApprovals: number;
    }
  | {
      kind: "research";
      questionsAnswered: number;
      sourcesReviewed: number;
      confidence: string;
      unresolvedUnknowns: number;
    }
  | {
      kind: "creative";
      draftsAndAssets: number;
      reviewStatus: string;
      publicationState: string;
      feedbackLoop: number;
    };

type Scoreboard = {
  hive: {
    id: string;
    kind: string;
    name: string;
    currentOutcome: string;
    status: string;
  };
  activeGoals: ListSummary;
  blockedItems: ListSummary;
  ownerActionsNeeded: ListSummary;
  recentCompletions: ListSummary;
  nextRecommendedAction: string;
  emptyStateGuidance: string;
  kindMetrics: KindMetrics;
};

export function HiveScoreboard({
  hiveId,
  hiveKind,
  compact = false,
}: {
  hiveId: string;
  hiveKind?: string;
  compact?: boolean;
}) {
  const [scoreboard, setScoreboard] = useState<Scoreboard | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadScoreboard() {
      setLoadState("loading");
      setError(null);
      try {
        const res = await fetch(`/api/hives/${hiveId}/scoreboard`);
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `Scoreboard failed with ${res.status}`);
        if (!cancelled) {
          setScoreboard(body.data ?? null);
          setLoadState("loaded");
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load scoreboard");
          setLoadState("error");
        }
      }
    }

    void loadScoreboard();
    return () => {
      cancelled = true;
    };
  }, [hiveId]);

  const effectiveKind = scoreboard?.hive.kind ?? hiveKind ?? "business";
  const metrics = useMemo(
    () => (scoreboard ? metricCards(scoreboard.kindMetrics) : []),
    [scoreboard],
  );

  if (loadState === "loading") {
    return (
      <section className="space-y-4 rounded-lg border p-6">
        <p className="text-sm text-zinc-400">Loading hive scoreboard...</p>
      </section>
    );
  }

  if (loadState === "error") {
    return (
      <section className="space-y-4 rounded-lg border p-6">
        <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">Hive scoreboard</h2>
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      </section>
    );
  }

  if (!scoreboard) return null;

  const hasMovement =
    scoreboard.activeGoals.count > 0 ||
    scoreboard.blockedItems.count > 0 ||
    scoreboard.ownerActionsNeeded.count > 0 ||
    scoreboard.recentCompletions.count > 0;

  return (
    <section className="space-y-5 rounded-lg border p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">Hive scoreboard</h2>
            <span className="rounded-full border px-2 py-0.5 text-xs text-zinc-600 dark:text-zinc-300">
              {labelForKind(effectiveKind)}
            </span>
            <span className="rounded-full border px-2 py-0.5 text-xs text-zinc-600 dark:text-zinc-300">
              {scoreboard.hive.status.replace("_", " ")}
            </span>
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">{scoreboard.hive.currentOutcome}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((metric) => (
          <div key={metric.label} className="rounded-md border p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{metric.label}</p>
            <p className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{metric.value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile icon={<Flag aria-hidden="true" />} label="Active goals" summary={scoreboard.activeGoals} />
        <SummaryTile icon={<AlertTriangle aria-hidden="true" />} label="Blocked items" summary={scoreboard.blockedItems} />
        <SummaryTile icon={<CircleDot aria-hidden="true" />} label="Owner actions" summary={scoreboard.ownerActionsNeeded} />
        <SummaryTile icon={<CheckCircle2 aria-hidden="true" />} label="Recent completions" summary={scoreboard.recentCompletions} />
      </div>

      <div className="rounded-md border border-amber-200/70 bg-amber-50/50 p-4 dark:border-amber-900/40 dark:bg-amber-950/10">
        <div className="flex items-start gap-3">
          <ArrowRight className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium text-amber-900 dark:text-amber-100">Next recommended action</p>
            <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{scoreboard.nextRecommendedAction}</p>
          </div>
        </div>
      </div>

      {!hasMovement && (
        <p className="rounded-md border border-dashed p-4 text-sm text-zinc-500 dark:text-zinc-400">
          {scoreboard.emptyStateGuidance}
        </p>
      )}

      {!compact && (
        <div className="grid gap-4 md:grid-cols-3">
          <DetailList title="What changed" items={scoreboard.recentCompletions.items} empty="No recent completions yet." />
          <DetailList title="What matters" items={[...scoreboard.ownerActionsNeeded.items, ...scoreboard.blockedItems.items]} empty="No owner actions or blockers right now." />
          <DetailList title="Active goals" items={scoreboard.activeGoals.items} empty="No active goals yet." />
        </div>
      )}
    </section>
  );
}

function SummaryTile({ icon, label, summary }: { icon: ReactNode; label: string; summary: ListSummary }) {
  const first = summary.items[0]?.title ?? summary.items[0]?.summary;
  return (
    <div className="rounded-md border p-4">
      <div className="flex items-center gap-2 text-zinc-500">
        <span className="[&>svg]:size-4">{icon}</span>
        <p className="text-xs font-medium uppercase tracking-wide">{label}</p>
      </div>
      <p className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{summary.count}</p>
      {first && <p className="mt-1 line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">{first}</p>}
    </div>
  );
}

function DetailList({ title, items, empty }: { title: string; items: ListItem[]; empty: string }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {items.slice(0, 3).map((item) => {
            const label = item.title ?? item.summary ?? "Untitled item";
            return (
              <li key={item.id} className="rounded-md border p-3 text-sm text-zinc-700 dark:text-zinc-300">
                {item.href ? (
                  <a href={item.href} className="font-medium text-amber-700 hover:underline dark:text-amber-300">
                    {label}
                  </a>
                ) : (
                  <>
                    <span>{label}</span>
                    <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
                      {item.targetLabel ?? "Informational"}
                    </span>
                  </>
                )}
                {item.priority && <span className="ml-2 text-xs text-zinc-500">({item.priority})</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function metricCards(metrics: KindMetrics): Array<{ label: string; value: string }> {
  switch (metrics.kind) {
    case "business":
      return [
        { label: "Revenue", value: formatCents(metrics.revenueCents) },
        { label: "Expenses", value: formatCents(metrics.expensesCents) },
        { label: "Pipeline", value: String(metrics.salesPipeline) },
        { label: "Profit / loss", value: formatCents(metrics.profitLossEstimateCents) },
      ];
    case "personal_project":
      return [
        { label: "Milestone progress", value: `${metrics.milestoneProgress.completed}/${metrics.milestoneProgress.total}` },
        { label: "Open blockers", value: String(metrics.openBlockers) },
        { label: "Deliverables", value: String(metrics.deliverablesProduced) },
        { label: "Deadline risk", value: metrics.deadlineRisk },
      ];
    case "personal_assistant":
      return [
        { label: "Open requests", value: String(metrics.openRequests) },
        { label: "Overdue reminders", value: String(metrics.overdueReminders) },
        { label: "Waiting on owner", value: String(metrics.waitingOnOwnerItems) },
        { label: "Sensitive approvals", value: String(metrics.sensitiveApprovals) },
      ];
    case "research":
      return [
        { label: "Questions answered", value: String(metrics.questionsAnswered) },
        { label: "Sources reviewed", value: String(metrics.sourcesReviewed) },
        { label: "Confidence", value: metrics.confidence },
        { label: "Unresolved unknowns", value: String(metrics.unresolvedUnknowns) },
      ];
    case "creative":
      return [
        { label: "Drafts / assets", value: String(metrics.draftsAndAssets) },
        { label: "Review status", value: metrics.reviewStatus },
        { label: "Publication", value: metrics.publicationState },
        { label: "Feedback loop", value: String(metrics.feedbackLoop) },
      ];
  }
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function labelForKind(kind: string): string {
  switch (kind) {
    case "personal_project":
      return "Personal project";
    case "personal_assistant":
      return "Personal assistant";
    case "research":
      return "Research";
    case "creative":
      return "Creative";
    default:
      return "Business";
  }
}
