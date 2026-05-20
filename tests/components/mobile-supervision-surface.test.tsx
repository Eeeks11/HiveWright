// @vitest-environment jsdom

import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileSupervisionSurface } from "../../src/components/mobile-supervision-surface";

function renderSurface() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MobileSupervisionSurface hiveId="hive-1" hiveName="HiveWright" />
    </QueryClientProvider>,
  );
}

function briefPayload() {
  return {
    flags: {
      urgentDecisions: 1,
      pendingDecisions: 1,
      pendingQualityFeedback: 0,
      totalPendingDecisions: 1,
      stalledGoals: 0,
      waitingGoals: 1,
      atRiskGoals: 0,
      unresolvableTasks: 0,
      expiringCreds: 0,
      unreadOutcomes: 0,
    },
    pendingDecisions: [],
    goals: [],
    recentCompletions: [],
    latestOutcomes: [],
    newInsights: [],
    costs: { todayCents: 0, weekCents: 0, monthCents: 0 },
    activity: { tasksCompleted24h: 0, tasksFailed24h: 0, goalsCompleted7d: 0 },
    initiative: {
      latestRun: null,
      last7d: {
        windowHours: 168,
        runCount: 0,
        completedRuns: 0,
        failedRuns: 0,
        evaluatedCandidates: 0,
        createdItems: 0,
        suppressedItems: 0,
        runFailures: 0,
        suppressionReasons: [],
      },
    },
    operationLock: {
      creationPause: {
        paused: true,
        reason: "Manual recovery",
        pausedBy: "owner",
        updatedAt: "2026-05-18T09:00:00.000Z",
      },
      resumeReadiness: {
        status: "blocked",
        canResumeSafely: false,
        counts: {
          enabledSchedules: 2,
          runnableTasks: 1,
          pendingDecisions: 1,
          unresolvableTasks: 0,
        },
        models: {
          enabled: 2,
          ready: 1,
          blocked: 1,
          blockedRoutes: [
            {
              provider: "moonshot",
              adapterType: "openai-compatible",
              modelId: "kimi-2.6",
              canRun: false,
              reason: "health_probe_missing",
              status: "unknown",
              lastProbedAt: null,
              nextProbeAt: null,
              failureReason: "No probe row yet",
            },
          ],
        },
        blockers: [
          {
            code: "pending_decisions",
            label: "Owner decisions are pending",
            count: 1,
            detail: "Resolve owner-tier decisions first.",
          },
        ],
        checkedAt: "2026-05-18T09:05:00.000Z",
      },
    },
    generatedAt: "2026-05-18T09:05:00.000Z",
  };
}

function decisionPayload() {
  return {
    data: [
      {
        id: "decision-resume-1",
        title: "Approve resume from creation pause",
        context: "Approve the paused-to-running transition for this exact pause state before schedules are re-enabled.",
        recommendation: "Approve only when the current pause reason is cleared and resume readiness is acceptable.",
        options: [
          { key: "approve", label: "Approve resume", response: "approved" },
          { key: "reject", label: "Keep paused", response: "rejected" },
        ],
        priority: "urgent",
        status: "pending",
        kind: "creation_pause_resume_approval",
        createdAt: "2026-05-18T08:00:00.000Z",
      },
    ],
  };
}

function activeTasksPayload() {
  return {
    tasks: [
      {
        id: "task-1",
        title: "Revise launch copy",
        assignedTo: "marketing-agent",
        createdBy: "owner",
        status: "active",
        parentTaskId: null,
        goalId: "goal-1",
        goalTitle: "Ship launch brief",
        adapterType: "codex",
        startedAt: "2026-05-18T08:20:00.000Z",
        createdAt: "2026-05-18T08:20:00.000Z",
        updatedAt: "2026-05-18T08:30:00.000Z",
        modelUsed: "openai/gpt-5.5",
      },
      {
        id: "task-2",
        title: "Investigate staging alert",
        assignedTo: "ops-agent",
        createdBy: "system",
        status: "active",
        parentTaskId: null,
        goalId: null,
        goalTitle: null,
        adapterType: "codex",
        startedAt: "2026-05-18T08:25:00.000Z",
        createdAt: "2026-05-18T08:25:00.000Z",
        updatedAt: "2026-05-18T08:35:00.000Z",
        modelUsed: "openai/gpt-5.5",
      },
    ],
  };
}

describe("MobileSupervisionSurface", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/brief?hiveId=hive-1") {
        return new Response(JSON.stringify({ data: briefPayload() }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.startsWith("/api/decisions?")) {
        return new Response(JSON.stringify(decisionPayload()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/active-tasks?hiveId=hive-1") {
        return new Response(JSON.stringify(activeTasksPayload()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/hives/hive-1/creation-pause" && !init) {
        return new Response(JSON.stringify({
          data: {
            paused: true,
            reason: "Manual recovery",
            pausedBy: "owner",
            updatedAt: "2026-05-18T09:00:00.000Z",
            operatingState: "paused",
            pausedScheduleIds: ["schedule-1"],
            resumeApproval: {
              status: "pending",
              decisionId: "decision-resume-1",
              requestedBy: "owner@example.com",
              requestedAt: "2026-05-18T09:06:00.000Z",
              approvedBy: null,
              approvedAt: null,
            },
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/hives/hive-1/creation-pause/control-plane") {
        return new Response(JSON.stringify({
          data: {
            workflow: {
              id: "creation_pause_resume",
              label: "Creation pause / resume",
            },
            currentRunState: {
              label: "Paused · approval pending",
              detail: "Creation is paused. A distinct approval is still required before the paused-to-running transition can execute.",
              creationPaused: true,
              operatingState: "paused",
              resumeReadinessStatus: "blocked",
            },
            approvalBoundary: {
              status: "pending",
              label: "Pending approval",
              detail: "Approve the current pause-state transition before schedules can be restored.",
              decisionId: "decision-resume-1",
              pendingCount: 1,
              requestedBy: "owner@example.com",
              requestedAt: "2026-05-18T09:06:00.000Z",
              approvedBy: null,
              approvedAt: null,
            },
            actingIdentity: {
              label: "owner@example.com",
              source: "resume approval requested by",
            },
            recentActivity: [
              {
                id: "event-1",
                kind: "action",
                title: "Creation paused",
                detail: "Paused from dashboard",
                actor: "owner@example.com",
                occurredAt: "2026-05-18T09:00:00.000Z",
                href: null,
              },
              {
                id: "artifact-1",
                kind: "artifact",
                title: "Recovery checklist",
                detail: "Artifact published · markdown",
                actor: null,
                occurredAt: "2026-05-18T08:50:00.000Z",
                href: "/deliverables/artifact-1",
              },
            ],
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/decisions/decision-resume-1/respond" && init?.method === "POST") {
        return new Response(JSON.stringify({ data: { status: "resolved" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/goals/goal-1/comments" && init?.method === "POST") {
        return new Response(JSON.stringify({
          data: {
            comment: {
              id: "comment-1",
              goalId: "goal-1",
              body: "Tighten the intro and keep the scope bounded.",
              createdBy: "owner",
              createdAt: "2026-05-18T09:10:00.000Z",
            },
          },
        }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("counts the pending resume approval displayed in the mobile decision feed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/brief?hiveId=hive-1") {
        const payload = briefPayload();
        return new Response(JSON.stringify({
          data: {
            ...payload,
            flags: {
              ...payload.flags,
              pendingDecisions: 0,
              totalPendingDecisions: 0,
            },
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.startsWith("/api/decisions?")) {
        return new Response(JSON.stringify(decisionPayload()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/active-tasks?hiveId=hive-1") {
        return new Response(JSON.stringify({ tasks: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/hives/hive-1/creation-pause") {
        return new Response(JSON.stringify({ data: { paused: true, reason: null, pausedBy: null, updatedAt: null, operatingState: "paused", pausedScheduleIds: [], resumeApproval: { status: "pending", decisionId: "decision-resume-1", requestedBy: null, requestedAt: null, approvedBy: null, approvedAt: null } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/hives/hive-1/creation-pause/control-plane") {
        return new Response(JSON.stringify({
          data: {
            workflow: { id: "creation_pause_resume", label: "Creation pause / resume" },
            currentRunState: { label: "Paused · approval pending", detail: "Pending", creationPaused: true, operatingState: "paused", resumeReadinessStatus: "blocked" },
            approvalBoundary: { status: "pending", label: "Pending approval", detail: "Pending", decisionId: "decision-resume-1", pendingCount: 1, requestedBy: null, requestedAt: null, approvedBy: null, approvedAt: null },
            actingIdentity: { label: "system", source: "test" },
            recentActivity: [],
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }));

    renderSurface();

    const decisionsCard = (await screen.findByText("Decisions")).closest("div");
    expect(decisionsCard).toBeTruthy();
    await waitFor(() => {
      expect(within(decisionsCard!).getByText("1")).toBeTruthy();
    });
    expect(await screen.findByText("Approve resume from creation pause")).toBeTruthy();
  });

  it("shows mobile supervision status, approves decisions, and handles redirect-eligible and no-goal active work", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    renderSurface();

    expect(await screen.findByText("Mobile supervision")).toBeTruthy();
    expect(await screen.findByText("Read-only operator view")).toBeTruthy();
    expect(await screen.findByText("Paused · approval pending")).toBeTruthy();
    expect(await screen.findByText("Pending approval")).toBeTruthy();
    expect((await screen.findAllByText("owner@example.com")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Creation paused")).toBeTruthy();
    expect(await screen.findByText("Recovery checklist")).toBeTruthy();
    expect(screen.getByText("Resume readiness")).toBeTruthy();
    expect(await screen.findByText("Blocked")).toBeTruthy();
    expect(await screen.findByText("Owner decisions are pending")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /Approval pending/i })).toBeTruthy();

    expect(await screen.findByText("Approve resume from creation pause")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve resume" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/decisions/decision-resume-1/respond",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            response: "approved",
            selectedOptionKey: "approve",
            selectedOptionLabel: "Approve resume",
          }),
        }),
      );
    });

    expect(await screen.findByText("Revise launch copy")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Redirect Revise launch copy"), {
      target: { value: "Tighten the intro and keep the scope bounded." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send redirect" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/goals/goal-1/comments",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            body: "Tighten the intro and keep the scope bounded.",
            createdBy: "owner",
          }),
        }),
      );
    });

    const noGoalTask = screen.getByText("Investigate staging alert").closest("article");
    expect(noGoalTask).toBeTruthy();
    const noGoalTaskScope = within(noGoalTask!);

    expect(noGoalTaskScope.getByText("Redirect unavailable for this task.")).toBeTruthy();
    expect(
      noGoalTaskScope.getByText("Short redirects require a governed goal."),
    ).toBeTruthy();
    expect(
      noGoalTaskScope.getByText(
        "Use the existing task view or rerouting surfaces to inspect and redirect this work.",
      ),
    ).toBeTruthy();
    expect(noGoalTaskScope.queryByLabelText("Redirect Investigate staging alert")).toBeNull();
    expect(noGoalTaskScope.queryByRole("button", { name: "Send redirect" })).toBeNull();
    expect(noGoalTaskScope.queryByText("0/280")).toBeNull();
  });
});
