import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
}));

vi.mock("../../src/app/api/_lib/db", () => ({ sql: mocks.sql }));
vi.mock("../../src/app/api/_lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/hives/seed-schedules", () => ({ seedDefaultSchedules: vi.fn() }));
vi.mock("fs", () => ({ default: { mkdirSync: vi.fn() } }));

import { GET } from "../../src/app/api/hives/route";

describe("GET /api/hives Business OS acceptance status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
  });

  it("lists every business hive with an owner-visible Business OS status", async () => {
    mocks.sql.mockResolvedValueOnce([
      {
        id: "11111111-1111-4111-8111-111111111111",
        slug: "wm",
        name: "Whiston Management",
        type: "ops",
        kind: "business",
        description: "Existing business.",
        workspace_path: "/tmp/wm",
        is_system_fixture: false,
        created_at: "2026-06-01T00:00:00.000Z",
        business_os_profile_id: "profile-1",
        business_os_mode: "existing_business",
        business_os_status: "audit_in_progress",
        business_os_average_readiness_score: 42,
        business_os_open_gaps_count: 3,
        business_os_approvals_required_count: 2,
        business_os_next_action: "Review owner approvals",
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        slug: "newco",
        name: "New Co",
        type: "ops",
        kind: "business",
        description: "New business.",
        workspace_path: "/tmp/newco",
        is_system_fixture: false,
        created_at: "2026-06-02T00:00:00.000Z",
        business_os_profile_id: null,
        business_os_mode: null,
        business_os_status: "setup_required",
        business_os_average_readiness_score: null,
        business_os_open_gaps_count: 0,
        business_os_approvals_required_count: 0,
        business_os_next_action: "Set up or audit this business",
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        slug: "research",
        name: "Research Hive",
        type: "knowledge",
        kind: "research",
        description: "Non-business hive.",
        workspace_path: "/tmp/research",
        is_system_fixture: false,
        created_at: "2026-06-03T00:00:00.000Z",
        business_os_profile_id: null,
        business_os_mode: null,
        business_os_status: null,
        business_os_average_readiness_score: null,
        business_os_open_gaps_count: 0,
        business_os_approvals_required_count: 0,
        business_os_next_action: null,
      },
    ]);

    const res = await GET(new Request("http://localhost/api/hives"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([
      expect.objectContaining({
        slug: "wm",
        kind: "business",
        businessOs: expect.objectContaining({
          status: "audit_in_progress",
          mode: "existing_business",
          profileId: "profile-1",
          href: "/business-os/11111111-1111-4111-8111-111111111111",
          readiness: {
            state: "measured",
            averageScore: 42,
            label: "42% ready",
          },
          openGapsCount: 3,
          approvalsRequiredCount: 2,
          nextAction: "Review owner approvals",
          actionPreview: expect.objectContaining({
            title: "Review owner approvals",
            href: null,
            stateLabel: "Missing target",
          }),
        }),
      }),
      expect.objectContaining({
        slug: "newco",
        kind: "business",
        businessOs: expect.objectContaining({
          status: "setup_required",
          mode: null,
          profileId: null,
          href: "/hives/22222222-2222-4222-8222-222222222222/business-os/setup",
          readiness: {
            state: "unknown",
            averageScore: null,
            label: "Not measured",
          },
          openGapsCount: 0,
          approvalsRequiredCount: 0,
          nextAction: "Set up or audit this business",
          actionPreview: null,
        }),
      }),
      expect.objectContaining({
        slug: "research",
        kind: "research",
        businessOs: null,
      }),
    ]);
  });
});
