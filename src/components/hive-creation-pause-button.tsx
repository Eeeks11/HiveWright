"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

type HiveCreationPause = {
  paused: boolean;
  reason: string | null;
  pausedBy: string | null;
  updatedAt: string | null;
  operatingState: "normal" | "paused" | "recovery" | "degraded";
  pausedScheduleIds: string[];
  resumeApproval: {
    status: "not_required" | "approval_needed" | "pending" | "approved";
    decisionId: string | null;
    requestedBy: string | null;
    requestedAt: string | null;
    approvedBy: string | null;
    approvedAt: string | null;
  };
};

async function fetchCreationPause(hiveId: string): Promise<HiveCreationPause> {
  const res = await fetch(`/api/hives/${hiveId}/creation-pause`);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? "Failed to load hive pause state");
  return body.data;
}

async function setCreationPause(input: {
  hiveId: string;
  paused: boolean;
  reason?: string;
  approvalDecisionId?: string;
}): Promise<HiveCreationPause> {
  const res = await fetch(`/api/hives/${input.hiveId}/creation-pause`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paused: input.paused,
      reason: input.reason,
      approvalDecisionId: input.approvalDecisionId,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? "Failed to update hive pause state");
  return body.data;
}

export function HiveCreationPauseButton({ hiveId }: { hiveId: string }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["hive-creation-pause", hiveId],
    queryFn: () => fetchCreationPause(hiveId),
    refetchInterval: 30_000,
  });
  const mutation = useMutation({
    mutationFn: setCreationPause,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["hive-creation-pause", hiveId] }),
        queryClient.invalidateQueries({ queryKey: ["brief", hiveId] }),
        queryClient.invalidateQueries({ queryKey: ["mobile-supervision", "decisions", hiveId] }),
        queryClient.invalidateQueries({ queryKey: ["creation-pause-control-plane", hiveId] }),
      ]);
    },
  });

  const paused = data?.paused ?? false;
  const resumeApproval = data?.resumeApproval;
  const busy = mutation.isPending;
  const approvalPending = paused && resumeApproval?.status === "pending";
  const canResumeNow = paused && resumeApproval?.status === "approved" && Boolean(resumeApproval.decisionId);
  const label = paused
    ? approvalPending
      ? "Approval pending"
      : canResumeNow
        ? "Resume work"
        : "Request resume approval"
    : "Pause Hive";
  const title = approvalPending
    ? "Resume approval pending"
    : data?.reason ?? undefined;

  return (
    <Button
      type="button"
      size="sm"
      variant={paused ? "outline" : "destructive"}
      disabled={busy || approvalPending}
      title={title}
      onClick={() => {
        mutation.mutate({
          hiveId,
          paused: !paused,
          reason: paused ? undefined : "Paused from dashboard",
          approvalDecisionId: canResumeNow ? resumeApproval.decisionId ?? undefined : undefined,
        });
      }}
    >
      {paused ? (
        <Play className="size-3.5" aria-hidden="true" />
      ) : (
        <Pause className="size-3.5" aria-hidden="true" />
      )}
      {label}
    </Button>
  );
}
