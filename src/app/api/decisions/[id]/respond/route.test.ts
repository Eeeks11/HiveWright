import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const queue: unknown[] = [];
  const sql = Object.assign(
    vi.fn((strings: TemplateStringsArray) => {
      calls.push(strings.join("?"));
      return Promise.resolve(queue.shift() ?? []);
    }),
    { calls, queue, json: vi.fn((value: unknown) => value), begin: vi.fn() },
  );
  return {
    sql,
    requireApiUser: vi.fn(),
    canAccessHive: vi.fn(),
    maybeCreateQualityDoctorForSignal: vi.fn(),
    mirrorOwnerDecisionCommentToGoalComment: vi.fn(),
    recordAgentAuditEventBestEffort: vi.fn(),
  };
});

vi.mock("../../../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../../../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

vi.mock("@/quality/doctor", () => ({
  maybeCreateQualityDoctorForSignal: mocks.maybeCreateQualityDoctorForSignal,
}));

vi.mock("@/decisions/owner-comment-wake", () => ({
  mirrorOwnerDecisionCommentToGoalComment: mocks.mirrorOwnerDecisionCommentToGoalComment,
}));

vi.mock("@/audit/agent-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/audit/agent-events")>();
  return {
    ...actual,
    recordAgentAuditEventBestEffort: mocks.recordAgentAuditEventBestEffort,
  };
});

import { POST } from "./route";

function request(body: unknown) {
  return new Request("http://localhost/api/decisions/decision-1/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const qualityDecision = {
  id: "decision-1",
  hive_id: "hive-1",
  goal_id: null,
  task_id: "task-1",
  title: "Task quality check",
  context: "Context",
  recommendation: "Rate it",
  options: { kind: "task_quality_feedback" },
  kind: "task_quality_feedback",
  priority: "normal",
  status: "resolved",
  owner_response: null,
  selected_option_key: null,
  selected_option_label: null,
  created_at: new Date("2026-04-28T00:00:00Z"),
  resolved_at: new Date("2026-04-28T01:00:00Z"),
};

describe("POST /api/decisions/[id]/respond quality feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sql.calls.length = 0;
    mocks.sql.queue.length = 0;
    mocks.sql.begin.mockImplementation(async (callback: (tx: typeof mocks.sql) => unknown) => callback(mocks.sql));
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.recordAgentAuditEventBestEffort.mockResolvedValue(undefined);
  });

  it("resolves a quality feedback rating and writes an explicit owner signal", async () => {
    mocks.sql.queue.push(
      [{ hive_id: "hive-1", kind: "task_quality_feedback", options: { kind: "task_quality_feedback" } }],
      [qualityDecision],
      [],
      [{ id: "signal-1" }],
    );

    const res = await POST(request({
      response: "quality_feedback",
      rating: 8,
      comment: "Strong result.",
    }), { params: Promise.resolve({ id: "decision-1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.status).toBe("resolved");
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "owner-1", "hive-1");
    expect(mocks.sql.calls.some((call) => call.includes("resolved_by"))).toBe(true);
    expect(mocks.sql.calls.some((call) => call.includes("INSERT INTO task_quality_signals"))).toBe(true);
    expect(mocks.maybeCreateQualityDoctorForSignal).toHaveBeenCalledWith(
      mocks.sql,
      "task-1",
      expect.objectContaining({ source: "explicit_owner_feedback", rating: 8 }),
    );
  });

  it("resolves a dismiss response without writing a quality signal", async () => {
    mocks.sql.queue.push(
      [{ hive_id: "hive-1", kind: "task_quality_feedback", options: { kind: "task_quality_feedback" } }],
      [qualityDecision],
      [],
    );

    const res = await POST(request({
      response: "dismiss_quality_feedback",
      comment: "No opinion.",
    }), { params: Promise.resolve({ id: "decision-1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.status).toBe("resolved");
    expect(mocks.sql.calls.some((call) => call.includes("INSERT INTO task_quality_signals"))).toBe(false);
    expect(mocks.maybeCreateQualityDoctorForSignal).not.toHaveBeenCalled();
  });

  it("emits decision.approved through the canonical action log without owner comments", async () => {
    mocks.sql.queue.push(
      [{ hive_id: "hive-1", kind: "decision", options: { options: [{ key: "approve" }] } }],
      [{
        ...qualityDecision,
        kind: "decision",
        options: { options: [{ key: "approve" }] },
        owner_response: "approved: Ship it, but do not log this comment",
        selected_option_key: "approve",
        selected_option_label: "Approve",
      }],
      [],
    );

    const res = await POST(request({
      response: "approved",
      selectedOptionKey: "approve",
      comment: "Ship it, but do not log this comment",
    }), { params: Promise.resolve({ id: "decision-1" }) });

    expect(res.status).toBe(200);
    expect(mocks.recordAgentAuditEventBestEffort).toHaveBeenCalledWith(
      mocks.sql,
      expect.objectContaining({
        eventType: "decision.approved",
        actor: { type: "owner", id: "owner-1", label: "owner@example.com" },
        hiveId: "hive-1",
        taskId: "task-1",
        targetType: "decision",
        targetId: "decision-1",
        metadata: expect.objectContaining({
          decisionId: "decision-1",
          source: "decision_respond",
          response: "approved",
          selectedOptionKey: "approve",
          selectedOptionLabelProvided: true,
          commentProvided: true,
        }),
      }),
    );
    const auditPayload = mocks.recordAgentAuditEventBestEffort.mock.calls[0]?.[1] as {
      metadata?: Record<string, unknown>;
    };
    expect(JSON.stringify(auditPayload.metadata)).not.toContain("Ship it");
    expect(JSON.stringify(auditPayload.metadata)).not.toContain("owner_response");
  });

  it("approves a Phase 3 Sales OS action by queueing it without connector runtime", async () => {
    const requestId = "66666666-6666-4666-8666-666666666666";
    const decisionForAuth = {
      hive_id: "hive-1",
      kind: "external_action_approval",
      options: { options: [{ key: "approve", label: "Approve" }, { key: "reject", label: "Reject" }] },
      route_metadata: { externalActionRequestId: requestId, domain: "sales-conversion", operation: "execute_sales_conversion_action" },
      status: "pending",
      owner_response: null,
      is_qa_fixture: false,
    };
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.sql.queue.push(
      [decisionForAuth],
      [{ id: requestId }],
      [{
        ...qualityDecision,
        id: "decision-1",
        kind: "external_action_approval",
        status: "resolved",
        owner_response: "approved",
        selected_option_key: "approve",
        selected_option_label: "Approve",
        route_metadata: decisionForAuth.route_metadata,
        is_qa_fixture: false,
      }],
      [],
      [{
        id: "draft-1",
        hive_id: "hive-1",
        action_plan_id: "plan-1",
        workflow: "lead_follow_up",
        request_payload: { title: "Follow up", draftBody: "Message draft" },
      }],
      [{ id: requestId, state: "succeeded", response_payload: { queued: true, mode: "manual_queue" } }],
      [{ id: "draft-1", approval_status: "approved", execution_status: "queued" }],
      [{ id: "log-1" }],
    );

    const res = await POST(request({
      response: "approved",
      selectedOptionKey: "approve",
    }), { params: Promise.resolve({ id: "decision-1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.externalActionResult).toMatchObject({
      requestId,
      status: "succeeded",
      result: { queued: true, mode: "manual_queue" },
    });
    expect(mocks.sql.begin).toHaveBeenCalledTimes(1);
    const sqlText = mocks.sql.calls.join("\n");
    expect(sqlText).toContain("sales_action_drafts");
    expect(sqlText).toContain("sales_execution_logs");
    expect(sqlText).not.toContain("connector_installs");
  });

  it("rejects invalid quality ratings", async () => {
    mocks.sql.queue.push([
      { hive_id: "hive-1", kind: "task_quality_feedback", options: { kind: "task_quality_feedback" } },
    ]);

    const res = await POST(request({
      response: "quality_feedback",
      rating: 11,
    }), { params: Promise.resolve({ id: "decision-1" }) });

    expect(res.status).toBe(400);
    expect(mocks.sql.calls.some((call) => call.includes("UPDATE decisions"))).toBe(false);
  });

  it("rejects callers without access to the decision hive", async () => {
    mocks.canAccessHive.mockResolvedValueOnce(false);
    mocks.sql.queue.push([
      { hive_id: "hive-2", kind: "task_quality_feedback", options: { kind: "task_quality_feedback" } },
    ]);

    const res = await POST(request({
      response: "quality_feedback",
      rating: 7,
    }), { params: Promise.resolve({ id: "decision-1" }) });

    expect(res.status).toBe(403);
    expect(mocks.sql.calls.some((call) => call.includes("UPDATE decisions"))).toBe(false);
  });
});
