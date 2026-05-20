import type { Sql, TransactionSql } from "postgres";
import { getHiveResumeReadiness } from "@/hives/resume-readiness";
import { getHiveCreationPause, type HiveCreationPause } from "@/operations/creation-pause";

export const CREATION_PAUSE_RESUME_APPROVAL_KIND = "creation_pause_resume_approval";

const CREATION_PAUSE_RESUME_APPROVAL_LOCK_KEY = "hivewright:creation-pause-resume-approval";

type ResumeApprovalStatus = "not_required" | "approval_needed" | "pending" | "approved";

type QuerySql = Sql | TransactionSql;

type ResumeApprovalDecisionRow = {
  id: string;
  status: string;
  owner_response: string | null;
  selected_option_key: string | null;
  resolved_by: string | null;
  created_at: Date | string;
  resolved_at: Date | string | null;
  route_metadata: unknown;
};

type RuntimeLockEventRow = {
  id: string;
  previous_state: string | null;
  next_state: string;
  creation_paused: boolean;
  reason: string | null;
  changed_by: string | null;
  created_at: Date | string;
};

type WorkProductActivityRow = {
  id: string;
  title: string | null;
  filename: string | null;
  artifact_kind: string | null;
  render_mode: string | null;
  public_url: string | null;
  published_at: Date | string | null;
  created_at: Date | string;
};

type ResumeApprovalRouteMetadata = {
  workflow?: unknown;
  targetState?: unknown;
  pauseUpdatedAt?: unknown;
  requestedBy?: unknown;
  requestedAt?: unknown;
};

export type CreationPauseControlState = HiveCreationPause & {
  resumeApproval: {
    status: ResumeApprovalStatus;
    decisionId: string | null;
    requestedBy: string | null;
    requestedAt: string | null;
    approvedBy: string | null;
    approvedAt: string | null;
  };
};

export type CreationPauseOperatorSnapshot = {
  workflow: {
    id: "creation_pause_resume";
    label: string;
  };
  currentRunState: {
    label: string;
    detail: string;
    creationPaused: boolean;
    operatingState: HiveCreationPause["operatingState"];
    resumeReadinessStatus: "running" | "ready" | "blocked";
  };
  approvalBoundary: {
    status: ResumeApprovalStatus;
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

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseResumeApprovalMetadata(value: unknown): ResumeApprovalRouteMetadata {
  return asRecord(value) ?? {};
}

function isApprovedResumeDecision(row: ResumeApprovalDecisionRow): boolean {
  if (row.selected_option_key === "approve") return true;
  if (row.owner_response === "approved") return true;
  return row.owner_response?.startsWith("approved:") ?? false;
}

function matchesCurrentPauseState(
  row: ResumeApprovalDecisionRow,
  pauseUpdatedAt: string | null,
): boolean {
  if (!pauseUpdatedAt) return false;
  const metadata = parseResumeApprovalMetadata(row.route_metadata);
  return metadata.workflow === "creation_pause_resume" &&
    metadata.targetState === "resume" &&
    metadata.pauseUpdatedAt === pauseUpdatedAt;
}

async function listResumeApprovalDecisions(
  db: QuerySql,
  hiveId: string,
): Promise<ResumeApprovalDecisionRow[]> {
  return await db<ResumeApprovalDecisionRow[]>`
    SELECT
      id,
      status,
      owner_response,
      selected_option_key,
      resolved_by,
      created_at,
      resolved_at,
      route_metadata
    FROM decisions
    WHERE hive_id = ${hiveId}::uuid
      AND kind = ${CREATION_PAUSE_RESUME_APPROVAL_KIND}
      AND is_qa_fixture = false
    ORDER BY created_at DESC
    LIMIT 12
  `;
}

function selectCurrentPauseApproval(
  rows: ResumeApprovalDecisionRow[],
  pauseUpdatedAt: string | null,
): CreationPauseControlState["resumeApproval"] {
  if (!pauseUpdatedAt) {
    return {
      status: "approval_needed",
      decisionId: null,
      requestedBy: null,
      requestedAt: null,
      approvedBy: null,
      approvedAt: null,
    };
  }

  const matchingRows = rows.filter((row) => matchesCurrentPauseState(row, pauseUpdatedAt));
  const approved = matchingRows.find((row) => row.status === "resolved" && isApprovedResumeDecision(row));
  if (approved) {
    const metadata = parseResumeApprovalMetadata(approved.route_metadata);
    return {
      status: "approved",
      decisionId: approved.id,
      requestedBy: typeof metadata.requestedBy === "string" ? metadata.requestedBy : null,
      requestedAt: typeof metadata.requestedAt === "string" ? metadata.requestedAt : null,
      approvedBy: approved.resolved_by ?? null,
      approvedAt: toIso(approved.resolved_at),
    };
  }

  const pending = matchingRows.find((row) => row.status === "pending");
  if (pending) {
    const metadata = parseResumeApprovalMetadata(pending.route_metadata);
    return {
      status: "pending",
      decisionId: pending.id,
      requestedBy: typeof metadata.requestedBy === "string" ? metadata.requestedBy : null,
      requestedAt: typeof metadata.requestedAt === "string" ? metadata.requestedAt : null,
      approvedBy: null,
      approvedAt: null,
    };
  }

  return {
    status: "approval_needed",
    decisionId: null,
    requestedBy: null,
    requestedAt: null,
    approvedBy: null,
    approvedAt: null,
  };
}

export async function getCreationPauseControlState(
  db: QuerySql,
  hiveId: string,
  pauseInput?: HiveCreationPause,
): Promise<CreationPauseControlState> {
  const pause = pauseInput ?? await getHiveCreationPause(db, hiveId);
  if (!pause.paused) {
    return {
      ...pause,
      resumeApproval: {
        status: "not_required",
        decisionId: null,
        requestedBy: null,
        requestedAt: null,
        approvedBy: null,
        approvedAt: null,
      },
    };
  }

  const decisions = await listResumeApprovalDecisions(db, hiveId);
  return {
    ...pause,
    resumeApproval: selectCurrentPauseApproval(decisions, pause.updatedAt),
  };
}

export async function requestCreationPauseResumeApproval(
  db: Sql,
  input: {
    hiveId: string;
    requestedBy: string | null;
    pauseInput?: HiveCreationPause;
  },
): Promise<CreationPauseControlState> {
  return await db.begin(async (tx) => {
    const lockKey = CREATION_PAUSE_RESUME_APPROVAL_LOCK_KEY + ":" + input.hiveId;
    await tx`
      SELECT pg_advisory_xact_lock(hashtext(${lockKey}))
    `;

    const pause = input.pauseInput ?? await getHiveCreationPause(tx, input.hiveId);
    if (!pause.paused) {
      return getCreationPauseControlState(tx, input.hiveId, pause);
    }

    const current = await getCreationPauseControlState(tx, input.hiveId, pause);
    if (current.resumeApproval.status === "pending" || current.resumeApproval.status === "approved") {
      return current;
    }

    const requestedAt = new Date().toISOString();
    const scheduleCount = pause.pausedScheduleIds.length;
    const scheduleSummary = scheduleCount === 0
      ? "No schedules were captured when the pause was set."
      : scheduleCount + " schedule" + (scheduleCount === 1 ? "" : "s") + " will be eligible for restoration when resume executes.";

    await tx`
      INSERT INTO decisions (
        hive_id,
        title,
        context,
        recommendation,
        options,
        priority,
        status,
        kind,
        route_metadata
      )
      VALUES (
        ${input.hiveId}::uuid,
        ${"Approve resume from creation pause"},
        ${[
          "Approve the paused-to-running transition for this exact pause state before schedules are re-enabled.",
          pause.reason ? "Pause reason: " + pause.reason + "." : null,
          scheduleSummary,
        ].filter(Boolean).join(" ")},
        ${"Approve only when the current pause reason is cleared and resume readiness is acceptable."},
        ${tx.json([
          {
            key: "approve",
            label: "Approve resume",
            response: "approved",
            consequence: "Allows the operator to execute the paused-to-running transition for this exact pause state.",
          },
          {
            key: "reject",
            label: "Keep paused",
            response: "rejected",
            consequence: "Leaves the hive paused until a new approval request is raised.",
          },
        ])},
        ${"urgent"},
        ${"pending"},
        ${CREATION_PAUSE_RESUME_APPROVAL_KIND},
        ${tx.json({
          workflow: "creation_pause_resume",
          targetState: "resume",
          pauseUpdatedAt: pause.updatedAt,
          requestedBy: input.requestedBy,
          requestedAt,
        })}
      )
    `;

    return getCreationPauseControlState(tx, input.hiveId, pause);
  });
}

function stateLabel(
  pause: HiveCreationPause,
  resumeReadinessStatus: "running" | "ready" | "blocked",
  resumeApprovalStatus: ResumeApprovalStatus,
): { label: string; detail: string } {
  if (pause.paused) {
    if (resumeApprovalStatus === "approved") {
      return {
        label: "Paused · resume approved",
        detail: "The approval boundary is satisfied. Use the existing control to execute the paused-to-running transition.",
      };
    }
    if (resumeApprovalStatus === "pending") {
      return {
        label: "Paused · approval pending",
        detail: "Creation is paused. A distinct approval is still required before the paused-to-running transition can execute.",
      };
    }
    return {
      label: "Paused · approval needed",
      detail: "Creation is paused. Request approval before the paused-to-running transition can execute.",
    };
  }

  if (resumeReadinessStatus === "running") {
    return {
      label: "Running",
      detail: "Creation is live and the workflow is already executing in its normal state.",
    };
  }
  if (resumeReadinessStatus === "ready") {
    return {
      label: "Ready",
      detail: "Creation is unpaused and the workflow is ready to accept work.",
    };
  }
  return {
    label: "Blocked",
    detail: "Creation is unpaused, but readiness blockers still prevent safe unattended operation.",
  };
}

function approvalLabel(status: ResumeApprovalStatus): { label: string; detail: string } {
  switch (status) {
    case "approved":
      return {
        label: "Resume approved",
        detail: "An attributable approval exists for this exact pause state. The operator can now execute resume.",
      };
    case "pending":
      return {
        label: "Pending approval",
        detail: "Approve the current pause-state transition before schedules can be restored.",
      };
    case "approval_needed":
      return {
        label: "Approval required",
        detail: "No approval is currently attached to this pause state. Request approval before resuming.",
      };
    default:
      return {
        label: "No approval required",
        detail: "The workflow is not paused, so no resume approval boundary is active.",
      };
  }
}

function activityFromLockEvent(row: RuntimeLockEventRow): CreationPauseOperatorSnapshot["recentActivity"][number] {
  return {
    id: row.id,
    kind: "action",
    title: row.creation_paused ? "Creation paused" : "Creation resumed",
    detail: row.reason?.trim() || `${row.previous_state ?? "unknown"} -> ${row.next_state}`,
    actor: row.changed_by ?? null,
    occurredAt: toIso(row.created_at) ?? new Date(0).toISOString(),
    href: null,
  };
}

function activityFromWorkProduct(row: WorkProductActivityRow): CreationPauseOperatorSnapshot["recentActivity"][number] {
  const title = row.title?.trim() || row.filename?.trim() || "Artifact update";
  const renderMode = row.render_mode?.trim() || "internal";
  const href = row.public_url?.trim()
    ? row.public_url
    : `/deliverables/${row.id}`;

  return {
    id: row.id,
    kind: "artifact",
    title,
    detail: `Artifact published${row.artifact_kind ? ` · ${row.artifact_kind}` : ""} · ${renderMode}`,
    actor: null,
    occurredAt: toIso(row.published_at ?? row.created_at) ?? new Date(0).toISOString(),
    href,
  };
}

export async function getCreationPauseOperatorSnapshot(
  db: Sql,
  hiveId: string,
): Promise<CreationPauseOperatorSnapshot> {
  const pause = await getHiveCreationPause(db, hiveId);
  const [controlState, resumeReadiness, lockEvents, artifactRows] = await Promise.all([
    getCreationPauseControlState(db, hiveId, pause),
    getHiveResumeReadiness(db, {
      hiveId,
      creationPause: pause,
    }),
    db<RuntimeLockEventRow[]>`
      SELECT
        id,
        previous_state,
        next_state,
        creation_paused,
        reason,
        changed_by,
        created_at
      FROM hive_runtime_lock_events
      WHERE hive_id = ${hiveId}::uuid
      ORDER BY created_at DESC
      LIMIT 4
    `,
    db<WorkProductActivityRow[]>`
      SELECT
        id,
        title,
        filename,
        artifact_kind,
        render_mode,
        public_url,
        published_at,
        created_at
      FROM work_products
      WHERE hive_id = ${hiveId}::uuid
      ORDER BY published_at DESC NULLS LAST, created_at DESC
      LIMIT 4
    `,
  ]);

  const runState = stateLabel(pause, resumeReadiness.status, controlState.resumeApproval.status);
  const approval = approvalLabel(controlState.resumeApproval.status);
  const recentActivity = [
    ...lockEvents.map(activityFromLockEvent),
    ...artifactRows.map(activityFromWorkProduct),
  ]
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
    .slice(0, 6);

  const latestActor = recentActivity.find((item) => item.actor)?.actor ?? null;
  const actingIdentity = controlState.resumeApproval.status === "approved" && controlState.resumeApproval.approvedBy
    ? {
        label: controlState.resumeApproval.approvedBy,
        source: "resume approval approved by",
      }
    : controlState.resumeApproval.requestedBy
      ? {
          label: controlState.resumeApproval.requestedBy,
          source: "resume approval requested by",
        }
      : pause.pausedBy
        ? {
            label: pause.pausedBy,
            source: "current pause set by",
          }
        : {
            label: latestActor ?? "system",
            source: latestActor ? "latest runtime lock event" : "no attributed actor recorded",
          };

  return {
    workflow: {
      id: "creation_pause_resume",
      label: "Creation pause / resume",
    },
    currentRunState: {
      label: runState.label,
      detail: runState.detail,
      creationPaused: pause.paused,
      operatingState: pause.operatingState,
      resumeReadinessStatus: resumeReadiness.status,
    },
    approvalBoundary: {
      status: controlState.resumeApproval.status,
      label: approval.label,
      detail: approval.detail,
      decisionId: controlState.resumeApproval.decisionId,
      pendingCount: controlState.resumeApproval.status === "pending" ? 1 : 0,
      requestedBy: controlState.resumeApproval.requestedBy,
      requestedAt: controlState.resumeApproval.requestedAt,
      approvedBy: controlState.resumeApproval.approvedBy,
      approvedAt: controlState.resumeApproval.approvedAt,
    },
    actingIdentity,
    recentActivity,
  };
}
