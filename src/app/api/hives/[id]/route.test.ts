import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("../../_lib/auth", () => ({
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: vi.fn(),
  canMutateHive: vi.fn(),
}));

vi.mock("@/hives/operating-profile", () => ({
  getOperatingProfile: vi.fn(),
  upsertOperatingProfile: vi.fn(),
}));

vi.mock("@/ea/native/model-selection", () => ({
  getEaModelConfiguration: vi.fn(),
  updateEaModelConfiguration: vi.fn(),
}));

import { GET, PATCH } from "./route";
import { sql } from "../../_lib/db";
import { requireApiUser } from "../../_lib/auth";
import { canAccessHive, canMutateHive } from "@/auth/users";
import { getOperatingProfile, upsertOperatingProfile } from "@/hives/operating-profile";
import { getEaModelConfiguration, updateEaModelConfiguration } from "@/ea/native/model-selection";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockCanAccessHive = canAccessHive as unknown as ReturnType<typeof vi.fn>;
const mockCanMutateHive = canMutateHive as unknown as ReturnType<typeof vi.fn>;
const mockGetOperatingProfile = getOperatingProfile as unknown as ReturnType<typeof vi.fn>;
const mockUpsertOperatingProfile = upsertOperatingProfile as unknown as ReturnType<typeof vi.fn>;
const mockGetEaModelConfiguration = getEaModelConfiguration as unknown as ReturnType<typeof vi.fn>;
const mockUpdateEaModelConfiguration = updateEaModelConfiguration as unknown as ReturnType<typeof vi.fn>;

function patchRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/hives/hive-1", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: "hive-1" }) };

describe("GET /api/hives/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mockGetOperatingProfile.mockResolvedValue({
      kind: "research",
      purpose: "Investigate options",
      desiredOutcome: "Recommendation",
      current30DayOutcome: null,
      constraints: [],
      approvalRules: [],
      forbiddenActions: [],
      importantContext: [],
      successCriteria: [],
      stopOrPauseCriteria: [],
      kindProfile: {},
      isDerived: true,
    });
    mockGetEaModelConfiguration.mockResolvedValue({ primaryModel: null, fallbackModel: null });
  });

  it("returns hive kind and operating mode on detail responses", async () => {
    mockSql.mockResolvedValueOnce([{
      id: "hive-1",
      slug: "valid-hive",
      name: "Valid Hive",
      type: "business",
      kind: "research",
      operating_mode: "validating",
      description: null,
      mission: null,
      software_stack: null,
      workspace_path: "$HOME/hives/valid-hive/projects",
      is_system_fixture: false,
      ai_budget_cap_cents: null,
      ai_budget_window: "all_time",
      created_at: "2026-04-27T00:00:00.000Z",
    }]);

    const res = await GET(new Request("http://localhost/api/hives/hive-1"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      id: "hive-1",
      kind: "research",
      operatingMode: "validating",
      operatingProfile: expect.objectContaining({
        kind: "research",
        purpose: "Investigate options",
      }),
    });
    expect(mockGetOperatingProfile).toHaveBeenCalledWith(mockSql, "hive-1");
  });

  it("maps legacy null hive kind and operating mode to safe defaults on detail responses", async () => {
    mockSql.mockResolvedValueOnce([{
      id: "hive-1",
      slug: "legacy-hive",
      name: "Legacy Hive",
      type: "business",
      kind: null,
      operating_mode: null,
      description: null,
      mission: null,
      software_stack: null,
      workspace_path: "$HOME/hives/legacy-hive/projects",
      is_system_fixture: false,
      ai_budget_cap_cents: null,
      ai_budget_window: "all_time",
      created_at: "2026-04-27T00:00:00.000Z",
    }]);

    const res = await GET(new Request("http://localhost/api/hives/hive-1"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      kind: "business",
      operatingMode: "exploring",
    });
  });
});

describe("PATCH /api/hives/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mockGetOperatingProfile.mockResolvedValue(null);
    mockUpsertOperatingProfile.mockResolvedValue(null);
    mockGetEaModelConfiguration.mockResolvedValue({ primaryModel: null, fallbackModel: null });
    mockUpdateEaModelConfiguration.mockResolvedValue({ primaryModel: null, fallbackModel: null });
  });

  it("rejects unauthenticated callers before DB use", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await PATCH(patchRequest({ name: "Renamed" }), params);

    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockCanAccessHive).not.toHaveBeenCalled();
  });

  it("rejects viewers without hive mutation access before updates and leaves state unchanged", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockSql.mockResolvedValueOnce([{ id: "hive-1" }]);
    mockCanMutateHive.mockResolvedValueOnce(false);

    const res = await PATCH(patchRequest({ name: "Renamed" }), params);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: hive mutation access required");
    expect(mockCanMutateHive).toHaveBeenCalledWith(mockSql, "user-1", "hive-1");
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("allows non-owner users with hive access to update allowed fields", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      user: { id: "member-1", email: "member@example.com", isSystemOwner: false },
    });
    mockSql
      .mockResolvedValueOnce([{ id: "hive-1" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: "hive-1",
        slug: "valid-hive",
        name: "Renamed",
        type: "business",
        kind: "business",
        operating_mode: "exploring",
        description: null,
        mission: null,
        software_stack: null,
        workspace_path: "$HOME/hives/valid-hive/projects",
        is_system_fixture: false,
        ai_budget_cap_cents: null,
        ai_budget_window: "all_time",
        created_at: "2026-04-27T00:00:00.000Z",
      }]);
    mockCanMutateHive.mockResolvedValueOnce(true);

    const res = await PATCH(patchRequest({ name: "Renamed" }), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ id: "hive-1", name: "Renamed" });
    expect(mockCanMutateHive).toHaveBeenCalledWith(mockSql, "member-1", "hive-1");
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it("persists and returns the shared per-hive EA primary and fallback models", async () => {
    mockSql
      .mockResolvedValueOnce([{ id: "hive-1" }])
      .mockResolvedValueOnce([{
        id: "hive-1",
        slug: "valid-hive",
        name: "Valid Hive",
        type: "business",
        kind: "business",
        operating_mode: "exploring",
        description: null,
        mission: null,
        software_stack: null,
        workspace_path: "$HOME/hives/valid-hive/projects",
        is_system_fixture: false,
        ai_budget_cap_cents: null,
        ai_budget_window: "all_time",
        created_at: "2026-04-27T00:00:00.000Z",
      }]);
    mockGetEaModelConfiguration.mockResolvedValue({
      primaryModel: "openai-codex/gpt-5.6-sol",
      fallbackModel: "openai-codex/gpt-5.5",
    });

    const res = await PATCH(patchRequest({
      eaModelConfiguration: {
        primaryModel: "openai-codex/gpt-5.6-sol",
        fallbackModel: "openai-codex/gpt-5.5",
      },
    }), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockUpdateEaModelConfiguration).toHaveBeenCalledWith(mockSql, "hive-1", {
      primaryModel: "openai-codex/gpt-5.6-sol",
      fallbackModel: "openai-codex/gpt-5.5",
    });
    expect(body.data.eaModelConfiguration).toEqual({
      primaryModel: "openai-codex/gpt-5.6-sol",
      fallbackModel: "openai-codex/gpt-5.5",
    });
  });
});
