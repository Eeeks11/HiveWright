import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sql = Object.assign(vi.fn(), {
    unsafe: vi.fn(),
    json: vi.fn((value: unknown) => value),
  });
  return {
    sql,
    requireApiAuth: vi.fn(),
    requireApiUser: vi.fn(),
    enforceInternalTaskHiveScope: vi.fn(),
    canAccessHive: vi.fn(),
    requireEaDestinationHiveConfirmation: vi.fn(),
  };
});

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../_lib/auth", () => ({
  requireApiAuth: mocks.requireApiAuth,
  requireApiUser: mocks.requireApiUser,
  enforceInternalTaskHiveScope: mocks.enforceInternalTaskHiveScope,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
  canMutateHive: mocks.canAccessHive,
}));

vi.mock("@/ea/native/hive-switch-audit", () => ({
  maybeRecordEaHiveSwitch: vi.fn(),
  requireEaDestinationHiveConfirmation: mocks.requireEaDestinationHiveConfirmation,
}));

vi.mock("@/skills/self-creation", () => ({
  approveSkill: vi.fn(),
  archiveSkill: vi.fn(),
  proposeSkill: vi.fn(),
  publishSkill: vi.fn(),
  rejectSkill: vi.fn(),
  reviewSkill: vi.fn(),
}));

vi.mock("@/audit/agent-events", () => ({
  AGENT_AUDIT_EVENTS: {
    draftWorkflowEdited: "draft_workflow_edited",
    draftWorkflowApproved: "draft_workflow_approved",
    draftWorkflowRejected: "draft_workflow_rejected",
    workflowActivated: "workflow_activated",
  },
  recordAgentAuditEventBestEffort: vi.fn(),
}));

import { GET, PATCH, POST } from "./route";
import {
  approveSkill,
  archiveSkill,
  publishSkill,
  proposeSkill,
  rejectSkill,
  reviewSkill,
} from "@/skills/self-creation";
import { recordAgentAuditEventBestEffort } from "@/audit/agent-events";

const mockApproveSkill = vi.mocked(approveSkill);
const mockArchiveSkill = vi.mocked(archiveSkill);
const mockPublishSkill = vi.mocked(publishSkill);
const mockProposeSkill = vi.mocked(proposeSkill);
const mockRejectSkill = vi.mocked(rejectSkill);
const mockReviewSkill = vi.mocked(reviewSkill);
const mockRecordAudit = vi.mocked(recordAgentAuditEventBestEffort);

function captureDerivedDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: "draft-123",
    hiveId: "11111111-1111-4111-8111-111111111111",
    roleSlug: "owner",
    targetRoleSlugs: ["owner"],
    sourceTaskId: null,
    originatingTaskId: null,
    originatingFeedbackId: null,
    slug: "capture-session-workflow",
    content: "# Not logged",
    scope: "hive",
    sourceType: "internal",
    provenanceUrl: "/setup/workflow-capture/session-abc/review",
    internalSourceRef: "capture-session:session-abc",
    createdBy: "user",
    curatorState: "active",
    curatorPinned: false,
    useCount: 0,
    viewCount: 0,
    patchCount: 0,
    lastUsedAt: null,
    lastViewedAt: null,
    lastPatchedAt: null,
    licenseNotes: "Metadata-only owner capture.",
    securityReviewStatus: "approved",
    qaReviewStatus: "approved",
    evidence: [],
    status: "published",
    feedback: null,
    approvedBy: "qa",
    approvedAt: new Date("2026-05-01T01:02:00.000Z"),
    publishedBy: "owner-user",
    publishedAt: new Date("2026-05-01T01:03:00.000Z"),
    archivedBy: null,
    archivedAt: null,
    archiveReason: null,
    adoptionEvidence: [],
    createdAt: new Date("2026-05-01T01:01:00.000Z"),
    updatedAt: new Date("2026-05-01T01:03:00.000Z"),
    ...overrides,
  };
}

describe("GET /api/skill-drafts access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAuth.mockResolvedValue(null);
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.requireEaDestinationHiveConfirmation.mockResolvedValue({ ok: true });
    mocks.sql.mockResolvedValue([{ id: "11111111-1111-4111-8111-111111111111" }]);
    mocks.sql.unsafe.mockResolvedValue([]);
  });

  it("rejects unauthenticated callers before querying skill drafts", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const response = await GET(new Request("http://localhost/api/skill-drafts?hiveId=11111111-1111-4111-8111-111111111111"));

    expect(response.status).toBe(401);
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });

  it("returns 403 before querying when the caller cannot access the requested hive", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const response = await GET(new Request("http://localhost/api/skill-drafts?hiveId=11111111-1111-4111-8111-111111111111"));

    expect(response.status).toBe(403);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "11111111-1111-4111-8111-111111111111");
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });

  it("rejects missing hiveId before querying skill drafts", async () => {
    const response = await GET(new Request("http://localhost/api/skill-drafts"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("hiveId is required");
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });

  it("rejects invalid hiveId before querying skill drafts", async () => {
    const response = await GET(new Request("http://localhost/api/skill-drafts?hiveId=not-a-uuid"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("hiveId must be a valid UUID");
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });

  it("allows authenticated callers to list draft metadata", async () => {
    const createdAt = new Date("2026-04-29T00:00:00.000Z");
    mocks.sql.unsafe.mockResolvedValueOnce([
      {
        id: "draft-1",
        hive_id: "11111111-1111-4111-8111-111111111111",
        role_slug: "dev-agent",
        target_role_slugs: ["dev-agent"],
        source_task_id: null,
        originating_task_id: null,
        originating_feedback_id: null,
        slug: "reviewed-skill",
        content: "# Reviewed Skill",
        scope: "hive",
        source_type: "external",
        provenance_url: "https://example.com/skill.md",
        internal_source_ref: null,
        license_notes: "MIT",
        security_review_status: "pending",
        qa_review_status: "pending",
        evidence: [],
        status: "pending",
        feedback: null,
        approved_by: null,
        approved_at: null,
        published_by: null,
        published_at: null,
        archived_by: null,
        archived_at: null,
        archive_reason: null,
        adoption_evidence: [],
        created_at: createdAt,
        updated_at: createdAt,
      },
    ]);

    const response = await GET(new Request("http://localhost/api/skill-drafts?hiveId=11111111-1111-4111-8111-111111111111"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: "draft-1",
      hiveId: "11111111-1111-4111-8111-111111111111",
      sourceType: "external",
      provenanceUrl: "https://example.com/skill.md",
      securityReviewStatus: "pending",
      qaReviewStatus: "pending",
    });
    expect(mocks.sql.unsafe).toHaveBeenCalledTimes(1);
  });
});

describe("PATCH /api/skill-drafts capture-derived publish audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAuth.mockResolvedValue(null);
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-user", email: "owner@example.com", isSystemOwner: false },
    });
    mocks.enforceInternalTaskHiveScope.mockResolvedValue({ ok: true, scope: null });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.requireEaDestinationHiveConfirmation.mockResolvedValue({ ok: true });
    mocks.sql.mockResolvedValue([{ id: "draft-123", hiveId: "11111111-1111-4111-8111-111111111111" }]);
  });

  it("rejects callers without target draft hive access before mutation or audit emission", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "cross-hive-user", email: "other@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const response = await PATCH(new Request("http://localhost/api/skill-drafts", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "draft-123",
        action: "approve",
        reviewer: "cross-hive-user",
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toContain("cannot access this draft hive");
    expect(mocks.sql).toHaveBeenCalledTimes(1);
    expect(mocks.enforceInternalTaskHiveScope).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(mocks.canAccessHive).toHaveBeenCalledWith(
      mocks.sql,
      "cross-hive-user",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(mockReviewSkill).not.toHaveBeenCalled();
    expect(mockApproveSkill).not.toHaveBeenCalled();
    expect(mockRejectSkill).not.toHaveBeenCalled();
    expect(mockPublishSkill).not.toHaveBeenCalled();
    expect(mockArchiveSkill).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("allows valid internal task scope to approve a draft", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: {
        id: "internal-service-account",
        email: "service@hivewright.local",
        isSystemOwner: true,
      },
    });
    mocks.enforceInternalTaskHiveScope.mockResolvedValueOnce({
      ok: true,
      scope: {
        taskId: "task-1",
        hiveId: "11111111-1111-4111-8111-111111111111",
        assignedTo: "dev-agent",
        parentTaskId: null,
      },
    });
    mockApproveSkill.mockResolvedValueOnce(captureDerivedDraft({
      status: "approved",
      publishedAt: null,
    }) as Awaited<ReturnType<typeof approveSkill>>);

    const response = await PATCH(new Request("http://localhost/api/skill-drafts", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "draft-123",
        action: "approve",
      }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.enforceInternalTaskHiveScope).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mockApproveSkill).toHaveBeenCalledWith(mocks.sql, "draft-123", "system");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      mocks.sql,
      expect.objectContaining({
        eventType: "draft_workflow_approved",
        hiveId: "11111111-1111-4111-8111-111111111111",
      }),
    );
  });

  it("emits edit, approve, and reject events for capture-derived draft UX actions without payload contents", async () => {
    mockReviewSkill.mockResolvedValueOnce(captureDerivedDraft({
      status: "reviewing",
      feedback: "Contains sensitive feedback that must not be logged",
    }) as Awaited<ReturnType<typeof reviewSkill>>);
    mockApproveSkill.mockResolvedValueOnce(captureDerivedDraft({
      status: "approved",
      publishedAt: null,
    }) as Awaited<ReturnType<typeof approveSkill>>);
    mockRejectSkill.mockResolvedValueOnce(captureDerivedDraft({
      status: "rejected",
      feedback: "Reject because password hunter2 appeared",
      publishedAt: null,
    }) as Awaited<ReturnType<typeof rejectSkill>>);

    const reviewResponse = await PATCH(new Request("http://localhost/api/skill-drafts", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "draft-123",
        action: "review",
        reviewer: "owner-user",
        feedback: "Contains sensitive feedback that must not be logged",
        qaReviewStatus: "approved",
      }),
    }));
    const approveResponse = await PATCH(new Request("http://localhost/api/skill-drafts", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "draft-123",
        action: "approve",
        reviewer: "owner-user",
      }),
    }));
    const rejectResponse = await PATCH(new Request("http://localhost/api/skill-drafts", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "draft-123",
        action: "reject",
        reviewer: "owner-user",
        feedback: "Reject because password hunter2 appeared",
      }),
    }));

    expect(reviewResponse.status).toBe(200);
    expect(approveResponse.status).toBe(200);
    expect(rejectResponse.status).toBe(200);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      mocks.sql,
      expect.objectContaining({
        eventType: "draft_workflow_edited",
        targetType: "skill_draft",
        targetId: "draft-123",
        metadata: expect.objectContaining({
          captureSessionId: "session-abc",
          skillDraftId: "draft-123",
          feedbackProvided: true,
          rawMediaPresent: false,
        }),
      }),
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      mocks.sql,
      expect.objectContaining({
        eventType: "draft_workflow_approved",
        targetType: "skill_draft",
        targetId: "draft-123",
        metadata: expect.objectContaining({
          activationStatus: "inactive",
          rawMediaPresent: false,
        }),
      }),
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      mocks.sql,
      expect.objectContaining({
        eventType: "draft_workflow_rejected",
        targetType: "skill_draft",
        targetId: "draft-123",
        metadata: expect.objectContaining({
          feedbackProvided: true,
          rawMediaPresent: false,
        }),
      }),
    );

    const serializedPayloads = JSON.stringify(
      mockRecordAudit.mock.calls.map((call) => call[1]),
    );
    expect(serializedPayloads).not.toContain("hunter2");
    expect(serializedPayloads).not.toContain("sensitive feedback");
  });

  it("emits workflow_activated for capture-derived skill draft publication", async () => {
    mockPublishSkill.mockResolvedValueOnce(
      captureDerivedDraft() as Awaited<ReturnType<typeof publishSkill>>,
    );

    const response = await PATCH(new Request("http://localhost/api/skill-drafts", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "draft-123",
        action: "publish",
        publishedBy: "owner-user",
      }),
    }));

    expect(response.status).toBe(200);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      mocks.sql,
      expect.objectContaining({
        eventType: "workflow_activated",
        actor: expect.objectContaining({
          id: "owner-user",
          type: "owner",
        }),
        hiveId: "11111111-1111-4111-8111-111111111111",
        targetType: "skill_draft",
        targetId: "draft-123",
        outcome: "success",
        metadata: expect.objectContaining({
          captureSessionId: "session-abc",
          skillDraftId: "draft-123",
          nextStatus: "published",
          rawMediaPresent: false,
          occurredAt: expect.any(String),
        }),
      }),
    );
    const auditPayload = mockRecordAudit.mock.calls[0]?.[1] as { metadata?: Record<string, unknown> };
    expect(JSON.stringify(auditPayload.metadata)).not.toContain("Not logged");
  });
});

describe("POST /api/skill-drafts access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.enforceInternalTaskHiveScope.mockResolvedValue({ ok: true, scope: null });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.requireEaDestinationHiveConfirmation.mockResolvedValue({ ok: true });
  });

  it("returns 403 before proposing when the caller cannot manage the hive", async () => {
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const response = await POST(new Request("http://localhost/api/skill-drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hiveId: "11111111-1111-4111-8111-111111111111",
        roleSlug: "dev-agent",
        slug: "draft",
        content: "# Draft",
        scope: "hive",
      }),
    }));

    expect(response.status).toBe(403);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "11111111-1111-4111-8111-111111111111");
    expect(mockProposeSkill).not.toHaveBeenCalled();
  });
});
