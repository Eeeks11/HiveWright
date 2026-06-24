import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
}));

vi.mock("../../../_lib/db", () => ({ sql: mocks.sql }));
vi.mock("../../../_lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/auth/users", () => ({ canAccessHive: mocks.canAccessHive }));

import { GET } from "./route";

const hiveId = "11111111-1111-4111-8111-111111111111";

describe("GET /api/hives/[id]/business-os-dashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
  });

  it("returns an owner dashboard that treats queued approval-required actions as approvals", async () => {
    mocks.sql
      .mockResolvedValueOnce([{
        id: "profile-1",
        business_mode: "existing_business",
        business_name: "Whiston Management",
        stage: "operating",
        summary: "Existing business audit.",
        owner_goals: ["Show the owner what matters"],
        approval_policy: { spendActions: "owner_approval_required" },
        ai_spend_budget: { capCents: 10000, window: "monthly" },
        autonomy_policy: { posture: "supervised" },
        updated_at: "2026-06-24T01:00:00.000Z",
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        audit_status: "completed",
        overall_readiness_score: 62,
        overall_confidence: "medium",
        audit_scope: ["finance"],
        evidence_sources: [{ label: "dogfood" }],
        known_unknowns: [],
        completed_at: "2026-06-24T02:00:00.000Z",
        updated_at: "2026-06-24T02:00:00.000Z",
      }])
      .mockResolvedValueOnce([{
        system_key: "finance_admin",
        system_label: "Finance/admin",
        readiness_score: 35,
        maturity_level: "ad_hoc",
        confidence: "medium",
        evidence_refs: [{ label: "audit" }],
        summary: "Thin evidence.",
        updated_at: "2026-06-24T03:00:00.000Z",
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        title: "Approve finance evidence review",
        brief: "Owner approval is required before execution.",
        status: "queued",
        priority: 90,
        risk_level: "medium",
        approval_required: true,
        expected_outcome: "Safe execution boundary.",
        measurement_plan: { metric: "approval_review_completed" },
        source_refs: [{ label: "template" }],
        created_at: "2026-06-24T04:00:00.000Z",
        updated_at: "2026-06-24T04:00:00.000Z",
      }])
      .mockResolvedValueOnce([{
        title: "Dogfood run",
        summary: "Verified rows.",
        status: "completed",
        role: "hivewright-developer",
        evidence_url: "/deliverables/work-product-1",
        updated_at: "2026-06-24T05:00:00.000Z",
      }]);

    const res = await GET(new Request(`http://localhost/api/hives/${hiveId}/business-os-dashboard`), {
      params: Promise.resolve({ id: hiveId }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.headline).toContain("Whiston Management");
    expect(body.data.approvalsRequired).toHaveLength(1);
    expect(body.data.approvalsRequired[0]).toMatchObject({
      title: "Approve finance evidence review",
      status: "queued",
    });
    expect(body.data.systemMaturity.atRiskSystems).toEqual(["Finance/admin"]);
    expect(body.data.agentActivity[0]).toMatchObject({ hasEvidence: true });
  });

  it("returns unknown readiness evidence when a profile has no audit/readiness rows", async () => {
    mocks.sql
      .mockResolvedValueOnce([{
        id: "profile-1",
        business_mode: "existing_business",
        business_name: "Whiston Management",
        stage: "operating",
        summary: "Existing business audit has not started.",
        owner_goals: ["Show unknown readiness honestly"],
        approval_policy: {},
        ai_spend_budget: {},
        autonomy_policy: {},
        updated_at: "2026-06-24T01:00:00.000Z",
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await GET(new Request(`http://localhost/api/hives/${hiveId}/business-os-dashboard`), {
      params: Promise.resolve({ id: hiveId }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.auditScorecard).toMatchObject({ status: "not_started", score: null });
    expect(body.data.systemMaturity).toMatchObject({
      averageReadinessScore: null,
      readinessEvidenceState: "unknown",
      readinessEvidenceMessage: "Readiness has not been measured yet. Treat this as missing evidence, not a healthy Business OS.",
      atRiskSystems: [],
    });
    expect(body.data.ownerNextReviewChecklist).toContain("Confirm readiness evidence before treating this Business OS as healthy.");
    expect(body.data.ownerNextReviewChecklist).not.toContain("No weak systems are currently below the readiness threshold.");
  });

  it("enforces hive access for non-owner callers", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "member-1", email: "member@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request(`http://localhost/api/hives/${hiveId}/business-os-dashboard`), {
      params: Promise.resolve({ id: hiveId }),
    });

    expect(res.status).toBe(403);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "member-1", hiveId);
    expect(mocks.sql).not.toHaveBeenCalled();
  });
});
