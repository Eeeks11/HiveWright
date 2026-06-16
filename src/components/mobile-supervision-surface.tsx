"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { HiveCreationPauseButton } from "@/components/hive-creation-pause-button";
import { Button, buttonVariants } from "@/components/ui/button";

type BriefPayload = {
  flags: {
    totalPendingDecisions: number;
  };
  operationLock?: {
    creationPause?: {
      paused: boolean;
      reason: string | null;
      pausedBy: string | null;
      updatedAt: string | null;
    };
    resumeReadiness?: {
      status: "running" | "ready" | "blocked";
      counts: {
        enabledSchedules: number;
        runnableTasks: number;
        pendingDecisions: number;
        unresolvableTasks: number;
      };
      models: {
        enabled: number;
        ready: number;
        blocked: number;
      };
      blockers: Array<{
        code: string;
        label: string;
        count: number;
        detail: string;
      }>;
      checkedAt: string;
    };
  };
  generatedAt: string;
};

type CreationPauseControlPlanePayload = {
  workflow: {
    id: "creation_pause_resume";
    label: string;
  };
  currentRunState: {
    label: string;
    detail: string;
    creationPaused: boolean;
    operatingState: "normal" | "paused" | "recovery" | "degraded";
    resumeReadinessStatus: "running" | "ready" | "blocked";
  };
  approvalBoundary: {
    status: "not_required" | "approval_needed" | "pending" | "approved";
    label: string;
    detail: string;
    decisionId: string | null;
    pendingCount: number;
    requestedBy: string | null;
    requestedAt: string | null;
    approvedBy: string | null;
    approvedAt: string | null;
  };
  actingIdentity: {
    label: string;
    source: string;
  };
  recentActivity: Array<{
    id: string;
    kind: "action" | "artifact";
    title: string;
    detail: string;
    actor: string | null;
    occurredAt: string;
    href: string | null;
  }>;
};

type DecisionOption = {
  key: string;
  label: string;
  response: string;
};

type PendingDecision = {
  id: string;
  title: string;
  context: string;
  recommendation: string | null;
  priority: string;
  createdAt: string;
  options: unknown;
};

type ActiveTask = {
  id: string;
  title: string;
  assignedTo: string;
  status: string;
  goalId: string | null;
  goalTitle: string | null;
  adapterType: string | null;
  updatedAt: string;
  modelUsed: string | null;
};

async function fetchBrief(hiveId: string): Promise<BriefPayload> {
  const res = await fetch(`/api/brief?hiveId=${hiveId}`);
  if (!res.ok) throw new Error(`brief failed: ${res.status}`);
  const body = await res.json();
  return body.data as BriefPayload;
}

async function fetchDecisions(hiveId: string): Promise<PendingDecision[]> {
  const params = new URLSearchParams({
    hiveId,
    status: "pending",
    includeKinds: "decision,creation_pause_resume_approval",
    limit: "6",
  });
  const res = await fetch(`/api/decisions?${params.toString()}`);
  if (!res.ok) throw new Error(`decisions failed: ${res.status}`);
  const body = await res.json();
  return (body.data ?? []) as PendingDecision[];
}

async function fetchCreationPauseControlPlane(hiveId: string): Promise<CreationPauseControlPlanePayload> {
  const res = await fetch(`/api/hives/${hiveId}/creation-pause/control-plane`);
  if (!res.ok) throw new Error(`creation-pause control-plane failed: ${res.status}`);
  const body = await res.json();
  return body.data as CreationPauseControlPlanePayload;
}

async function fetchActiveTasks(hiveId: string): Promise<ActiveTask[]> {
  const res = await fetch(`/api/active-tasks?hiveId=${hiveId}`);
  if (!res.ok) throw new Error(`active-tasks failed: ${res.status}`);
  const body = await res.json();
  return (body.tasks ?? []) as ActiveTask[];
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function modelLabel(modelUsed: string | null): string {
  if (!modelUsed) return "model pending";
  const slashIndex = modelUsed.indexOf("/");
  return slashIndex >= 0 ? modelUsed.slice(slashIndex + 1) : modelUsed;
}

function resumeTone(status: "running" | "ready" | "blocked") {
  if (status === "ready") return "bg-[rgba(126,155,126,0.16)] text-[#C7D8C2]";
  if (status === "blocked") return "bg-[rgba(194,74,44,0.16)] text-[#F0A096]";
  return "bg-white/[0.06] text-[#D4C8A8]";
}

function normaliseDecisionOptions(value: unknown): DecisionOption[] {
  const optionList = Array.isArray(value)
    ? value
    : value && typeof value === "object" && !Array.isArray(value) &&
        Array.isArray((value as { options?: unknown }).options)
      ? (value as { options: unknown[] }).options
      : [];

  return optionList.flatMap((option, index): DecisionOption[] => {
    if (typeof option === "string") {
      const trimmed = option.trim();
      return trimmed ? [{ key: trimmed, label: trimmed, response: "approved" }] : [];
    }
    if (!option || typeof option !== "object" || Array.isArray(option)) return [];

    const record = option as Record<string, unknown>;
    const key = readString(record, ["key", "optionKey", "action", "id", "value"]) ?? `option_${index + 1}`;
    const label = readString(record, ["label", "title", "name"]) ?? key;
    const response =
      readString(record, ["response", "canonicalResponse", "canonical_response"]) ??
      inferOptionResponse(key);

    return [{ key, label, response }];
  });
}

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function inferOptionResponse(key: string): string {
  if (/reject|dismiss|decline|cancel|abandon|drop|defer/i.test(key)) return "rejected";
  if (/discuss|clarify/i.test(key)) return "discussed";
  return "approved";
}

export function MobileSupervisionSurface({
  hiveId,
  hiveName,
}: {
  hiveId: string;
  hiveName: string;
}) {
  const queryClient = useQueryClient();
  const [redirectDrafts, setRedirectDrafts] = useState<Record<string, string>>({});
  const [redirectFeedback, setRedirectFeedback] = useState<Record<string, string>>({});

  const briefQuery = useQuery({
    queryKey: ["brief", hiveId],
    queryFn: () => fetchBrief(hiveId),
    refetchInterval: 30_000,
  });
  const decisionsQuery = useQuery({
    queryKey: ["mobile-supervision", "decisions", hiveId],
    queryFn: () => fetchDecisions(hiveId),
    refetchInterval: 30_000,
  });
  const controlPlaneQuery = useQuery({
    queryKey: ["creation-pause-control-plane", hiveId],
    queryFn: () => fetchCreationPauseControlPlane(hiveId),
    refetchInterval: 30_000,
  });
  const activeTasksQuery = useQuery({
    queryKey: ["mobile-supervision", "active-tasks", hiveId],
    queryFn: () => fetchActiveTasks(hiveId),
    refetchInterval: 30_000,
  });

  const decisionMutation = useMutation({
    mutationFn: async ({
      decisionId,
      response,
      selectedOptionKey,
      selectedOptionLabel,
    }: {
      decisionId: string;
      response: string;
      selectedOptionKey?: string;
      selectedOptionLabel?: string;
    }) => {
      const payload: Record<string, string> = { hiveId, response };
      if (selectedOptionKey) payload.selectedOptionKey = selectedOptionKey;
      if (selectedOptionLabel) payload.selectedOptionLabel = selectedOptionLabel;

      const res = await fetch(`/api/decisions/${decisionId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Failed to resolve decision");
    },
    onSuccess: async (_result, variables) => {
      queryClient.setQueryData<PendingDecision[]>(
        ["mobile-supervision", "decisions", hiveId],
        (current) => current?.filter((decision) => decision.id !== variables.decisionId) ?? [],
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["brief", hiveId] }),
        queryClient.invalidateQueries({ queryKey: ["hive-creation-pause", hiveId] }),
        queryClient.invalidateQueries({ queryKey: ["creation-pause-control-plane", hiveId] }),
      ]);
    },
  });

  const redirectMutation = useMutation({
    mutationFn: async ({ goalId, body }: { goalId: string; body: string }) => {
      const res = await fetch(`/api/goals/${goalId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiveId, body, createdBy: "owner" }),
      });
      if (!res.ok) throw new Error("Failed to send redirect");
    },
  });

  const readiness = briefQuery.data?.operationLock?.resumeReadiness;
  const creationPause = briefQuery.data?.operationLock?.creationPause;
  const decisions = decisionsQuery.data ?? [];
  const displayedDecisionCount = Math.max(
    briefQuery.data?.flags.totalPendingDecisions ?? 0,
    decisions.length,
    controlPlaneQuery.data?.approvalBoundary.pendingCount ?? 0,
  );
  const activeTasks = activeTasksQuery.data ?? [];

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <section className="rounded-[20px] border border-white/[0.08] bg-card/95 p-4 shadow-[0_18px_44px_rgba(0,0,0,0.22)]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-honey-300/80">
              Owner surface
            </p>
            <h1 className="mt-1 text-[24px] font-semibold tracking-[-0.02em] text-foreground">
              Mobile supervision
            </h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {hiveName} · async review, approvals, and bounded redirects
            </p>
          </div>
          <Link href="/" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Back
          </Link>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2">
          <div className="rounded-2xl border border-white/[0.06] bg-[#0F1114] p-3">
            <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Decisions</p>
            <p className="mt-1 text-lg font-semibold text-foreground">
              {displayedDecisionCount}
            </p>
          </div>
          <div className="rounded-2xl border border-white/[0.06] bg-[#0F1114] p-3">
            <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Active work</p>
            <p className="mt-1 text-lg font-semibold text-foreground">{activeTasks.length}</p>
          </div>
          <div className="rounded-2xl border border-white/[0.06] bg-[#0F1114] p-3">
            <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Creation</p>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {creationPause?.paused ? "Paused" : "Running"}
            </p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-white/[0.06] bg-[#0F1114] p-3">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Creation pause</p>
            <p className="mt-1 text-sm text-foreground">
              {creationPause?.reason ?? "Use the existing governed pause/resume control."}
            </p>
          </div>
          <HiveCreationPauseButton hiveId={hiveId} />
        </div>

        <div className="mt-4 rounded-2xl border border-white/[0.06] bg-[#0F1114] p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Resume readiness</p>
              <p className="mt-1 text-sm text-foreground">
                {readiness
                  ? `${readiness.counts.runnableTasks} runnable · ${readiness.counts.pendingDecisions} pending decisions · ${readiness.models.ready}/${readiness.models.enabled} models ready`
                  : "Readiness status unavailable."}
              </p>
            </div>
            {readiness && (
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${resumeTone(readiness.status)}`}>
                {readiness.status[0].toUpperCase() + readiness.status.slice(1)}
              </span>
            )}
          </div>
          {readiness?.blockers?.length ? (
            <div className="mt-3 space-y-2">
              {readiness.blockers.slice(0, 3).map((blocker) => (
                <div key={blocker.code} className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-3">
                  <p className="text-sm font-medium text-foreground">{blocker.label}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {blocker.detail}
                  </p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      <section className="rounded-[20px] border border-white/[0.08] bg-card/95 p-4 shadow-[0_18px_44px_rgba(0,0,0,0.22)]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-honey-300/80">
              Read-only operator view
            </p>
            <h2 className="mt-1 text-lg font-semibold text-foreground">Pause/resume workflow</h2>
          </div>
          <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[11px] font-medium text-muted-foreground">
            Internal only
          </span>
        </div>

        {controlPlaneQuery.isLoading ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading operator snapshot…</p>
        ) : controlPlaneQuery.error ? (
          <p className="mt-4 text-sm text-[#F0A096]">Operator snapshot unavailable.</p>
        ) : controlPlaneQuery.data ? (
          <>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-white/[0.06] bg-[#0F1114] p-3">
                <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Current run state</p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {controlPlaneQuery.data.currentRunState.label}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {controlPlaneQuery.data.currentRunState.detail}
                </p>
              </div>
              <div className="rounded-2xl border border-white/[0.06] bg-[#0F1114] p-3">
                <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Approval boundary</p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {controlPlaneQuery.data.approvalBoundary.label}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {controlPlaneQuery.data.approvalBoundary.detail}
                </p>
              </div>
              <div className="rounded-2xl border border-white/[0.06] bg-[#0F1114] p-3">
                <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Acting identity</p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {controlPlaneQuery.data.actingIdentity.label}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {controlPlaneQuery.data.actingIdentity.source}
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-white/[0.06] bg-[#0F1114] p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                    Recent actions and artifact changes
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Latest bounded workflow events for the existing pause/resume path.
                  </p>
                </div>
                <span className="rounded-full bg-white/[0.04] px-2 py-1 text-[11px] text-muted-foreground">
                  {controlPlaneQuery.data.approvalBoundary.pendingCount} pending approval
                  {controlPlaneQuery.data.approvalBoundary.pendingCount === 1 ? "" : "s"}
                </span>
              </div>

              {controlPlaneQuery.data.recentActivity.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">No recent control-plane activity recorded yet.</p>
              ) : (
                <div className="mt-3 space-y-2">
                  {controlPlaneQuery.data.recentActivity.map((item) => (
                    <div key={item.id} className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">{item.title}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>
                        </div>
                        <span className="text-[11px] text-muted-foreground">{relativeTime(item.occurredAt)}</span>
                      </div>
                      <p className="mt-2 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                        {item.actor ? item.actor : item.kind}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : null}
      </section>

      <section className="rounded-[20px] border border-white/[0.08] bg-card/95 p-4 shadow-[0_18px_44px_rgba(0,0,0,0.22)]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-honey-300/80">
              Pending decisions
            </p>
            <h2 className="mt-1 text-lg font-semibold text-foreground">Approve or reject</h2>
          </div>
          <Link href="/decisions" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Full inbox
          </Link>
        </div>

        {decisionsQuery.isLoading ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading decisions…</p>
        ) : decisionsQuery.error ? (
          <p className="mt-4 text-sm text-[#F0A096]">Decision feed unavailable.</p>
        ) : decisions.length === 0 ? (
          <p className="mt-4 rounded-2xl border border-dashed border-white/[0.08] p-4 text-sm text-muted-foreground">
            No pending owner decisions.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {decisions.map((decision) => {
              const options = normaliseDecisionOptions(decision.options);
              const isResolving = decisionMutation.isPending && decisionMutation.variables?.decisionId === decision.id;
              return (
                <article key={decision.id} className="rounded-2xl border border-white/[0.06] bg-[#0F1114] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-foreground">{decision.title}</h3>
                      <p className="mt-1 text-xs text-muted-foreground">{relativeTime(decision.createdAt)}</p>
                    </div>
                    <span className="rounded-full bg-honey-700/15 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300">
                      {decision.priority}
                    </span>
                  </div>
                  <p className="mt-3 text-sm text-[#D7D1C5]">{decision.context}</p>
                  {decision.recommendation ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Recommended: {decision.recommendation}
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {options.length > 0 ? (
                      options.map((option) => (
                        <Button
                          key={option.key}
                          type="button"
                          size="sm"
                          variant={option.response === "rejected" ? "destructive" : "outline"}
                          disabled={isResolving}
                          onClick={() => {
                            decisionMutation.mutate({
                              decisionId: decision.id,
                              response: option.response,
                              selectedOptionKey: option.key,
                              selectedOptionLabel: option.label,
                            });
                          }}
                        >
                          {option.label}
                        </Button>
                      ))
                    ) : (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          disabled={isResolving}
                          onClick={() => {
                            decisionMutation.mutate({ decisionId: decision.id, response: "approved" });
                          }}
                        >
                          Approve
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          disabled={isResolving}
                          onClick={() => {
                            decisionMutation.mutate({ decisionId: decision.id, response: "rejected" });
                          }}
                        >
                          Reject
                        </Button>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="rounded-[20px] border border-white/[0.08] bg-card/95 p-4 shadow-[0_18px_44px_rgba(0,0,0,0.22)]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-honey-300/80">
              Active work
            </p>
            <h2 className="mt-1 text-lg font-semibold text-foreground">Send a short redirect</h2>
          </div>
          <Link href="/tasks" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Task view
          </Link>
        </div>

        {activeTasksQuery.isLoading ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading active work…</p>
        ) : activeTasksQuery.error ? (
          <p className="mt-4 text-sm text-[#F0A096]">Active work feed unavailable.</p>
        ) : activeTasks.length === 0 ? (
          <p className="mt-4 rounded-2xl border border-dashed border-white/[0.08] p-4 text-sm text-muted-foreground">
            No active work is running for this hive.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {activeTasks.slice(0, 6).map((task) => {
              const draft = redirectDrafts[task.id] ?? "";
              const feedback = redirectFeedback[task.id];
              const isSubmitting = redirectMutation.isPending && redirectMutation.variables?.goalId === task.goalId;

              return (
                <article key={task.id} className="rounded-2xl border border-white/[0.06] bg-[#0F1114] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-foreground">{task.title}</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {task.assignedTo} · {task.status} · {relativeTime(task.updatedAt)}
                      </p>
                    </div>
                    <span className="rounded-full border border-white/[0.06] bg-white/[0.03] px-2 py-1 font-mono text-[11px] text-[#B8B0A0]">
                      {modelLabel(task.modelUsed)}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {task.goalId && task.goalTitle ? (
                      <Link href={`/goals/${task.goalId}`} className="text-honey-300 hover:text-honey-200">
                        {task.goalTitle}
                      </Link>
                    ) : (
                      <span>No governed goal target</span>
                    )}
                    {task.adapterType ? <span>{task.adapterType}</span> : null}
                  </div>

                  {task.goalId ? (
                    <form
                      className="mt-3 space-y-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const body = draft.trim();
                        if (!body) return;
                        redirectMutation.mutate(
                          { goalId: task.goalId!, body },
                          {
                            onSuccess: () => {
                              setRedirectDrafts((current) => ({ ...current, [task.id]: "" }));
                              setRedirectFeedback((current) => ({ ...current, [task.id]: "Redirect sent." }));
                            },
                            onError: () => {
                              setRedirectFeedback((current) => ({ ...current, [task.id]: "Redirect failed." }));
                            },
                          },
                        );
                      }}
                    >
                      <label className="block">
                        <span className="sr-only">{`Redirect ${task.title}`}</span>
                        <textarea
                          aria-label={`Redirect ${task.title}`}
                          rows={3}
                          maxLength={280}
                          value={draft}
                          onChange={(event) => {
                            const next = event.target.value;
                            setRedirectDrafts((current) => ({ ...current, [task.id]: next }));
                            if (redirectFeedback[task.id]) {
                              setRedirectFeedback((current) => ({ ...current, [task.id]: "" }));
                            }
                          }}
                          placeholder="Short redirect for the linked goal supervisor…"
                          className="w-full resize-none rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/45"
                        />
                      </label>
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-xs text-muted-foreground">{draft.length}/280</p>
                        <Button type="submit" size="sm" disabled={isSubmitting || !draft.trim()}>
                          Send redirect
                        </Button>
                      </div>
                      {feedback ? (
                        <p className="text-xs text-muted-foreground">{feedback}</p>
                      ) : null}
                    </form>
                  ) : (
                    <div className="mt-3 rounded-xl border border-dashed border-white/[0.08] p-3 text-sm text-muted-foreground">
                      <p>Redirect unavailable for this task.</p>
                      <p className="mt-2">Short redirects require a governed goal.</p>
                      <p className="mt-1">
                        Use the existing task view or rerouting surfaces to inspect and redirect this work.
                      </p>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <p className="px-1 text-center text-xs text-muted-foreground">
        Refreshed {briefQuery.data?.generatedAt ? relativeTime(briefQuery.data.generatedAt) : "recently"}.
      </p>
    </div>
  );
}
