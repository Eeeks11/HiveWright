import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("../../../../../_lib/auth", () => ({
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canMutateHive: vi.fn(),
}));

vi.mock("@/operating-loops/business-action-runtime", () => ({
  convertBusinessActionToAgentTask: vi.fn(),
  convertBusinessActionToSchedule: vi.fn(),
  convertBusinessActionToSopDraft: vi.fn(),
}));

import { canMutateHive } from "@/auth/users";
import {
  convertBusinessActionToAgentTask,
  convertBusinessActionToSchedule,
  convertBusinessActionToSopDraft,
} from "@/operating-loops/business-action-runtime";
import { requireApiUser } from "../../../../../_lib/auth";
import { sql } from "../../../../../_lib/db";
import { POST } from "./route";

const mockCanMutateHive = canMutateHive as unknown as ReturnType<typeof vi.fn>;
const mockConvertBusinessActionToAgentTask = convertBusinessActionToAgentTask as unknown as ReturnType<typeof vi.fn>;
const mockConvertBusinessActionToSchedule = convertBusinessActionToSchedule as unknown as ReturnType<typeof vi.fn>;
const mockConvertBusinessActionToSopDraft = convertBusinessActionToSopDraft as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

const hiveId = "11111111-1111-4111-8111-111111111111";
const actionId = "22222222-2222-4222-8222-222222222222";
const params = { params: Promise.resolve({ id: hiveId, actionId }) };

function postRequest(body: Record<string, unknown>) {
  return new Request(`http://localhost/api/hives/${hiveId}/business-os-actions/${actionId}/convert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/hives/[id]/business-os-actions/[actionId]/convert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockCanMutateHive.mockResolvedValue(true);
    mockSql.mockResolvedValue([{ id: actionId }]);
    mockConvertBusinessActionToAgentTask.mockResolvedValue({
      task: { id: "task-1" },
      action: { id: actionId, status: "running" },
    });
    mockConvertBusinessActionToSchedule.mockResolvedValue({
      schedule: { id: "schedule-1" },
      action: { id: actionId, status: "running" },
    });
    mockConvertBusinessActionToSopDraft.mockResolvedValue({
      task: { id: "task-2" },
      workProduct: { id: "work-product-1" },
      action: { id: actionId, status: "running" },
    });
  });

  it("returns 401 before DB use for signed-out callers", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await POST(postRequest({ conversion: "create_agent_task" }), params);

    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockCanMutateHive).not.toHaveBeenCalled();
  });

  it("requires hive mutation access for non-owner callers before conversion", async () => {
    mockCanMutateHive.mockResolvedValueOnce(false);

    const res = await POST(postRequest({ conversion: "create_agent_task" }), params);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/hive mutation access required/i);
    expect(mockCanMutateHive).toHaveBeenCalledWith(mockSql, "user-1", hiveId);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockConvertBusinessActionToAgentTask).not.toHaveBeenCalled();
  });

  it("rejects read-only hive viewers that do not have mutation access", async () => {
    mockCanMutateHive.mockResolvedValueOnce(false);

    const res = await POST(postRequest({ conversion: "create_schedule", cronExpression: "0 9 * * *" }), params);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/hive mutation access required/i);
    expect(mockCanMutateHive).toHaveBeenCalledWith(mockSql, "user-1", hiveId);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockConvertBusinessActionToSchedule).not.toHaveBeenCalled();
  });

  it("preserves system-owner conversion access without membership checks", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      user: { id: "system-owner-1", email: "owner@example.com", isSystemOwner: true },
    });

    const res = await POST(postRequest({ conversion: "create_agent_task" }), params);

    expect(res.status).toBe(201);
    expect(mockCanMutateHive).not.toHaveBeenCalled();
    expect(mockConvertBusinessActionToAgentTask).toHaveBeenCalledWith(mockSql, expect.objectContaining({
      actionId,
      createdBy: "system-owner-1",
    }));
  });

  it("requires the action to belong to the requested hive", async () => {
    mockSql.mockResolvedValueOnce([]);

    const res = await POST(postRequest({ conversion: "create_agent_task" }), params);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toMatch(/not found for hive/i);
    expect(mockConvertBusinessActionToAgentTask).not.toHaveBeenCalled();
  });

  it("converts an accessible Business OS action into an agent task", async () => {
    const res = await POST(postRequest({ conversion: "create_agent_task", assignedTo: "operations-agent", priority: 7 }), params);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data).toMatchObject({
      conversion: "create_agent_task",
      task: { id: "task-1" },
      action: { id: actionId, status: "running" },
    });
    expect(mockConvertBusinessActionToAgentTask).toHaveBeenCalledWith(mockSql, {
      actionId,
      assignedTo: "operations-agent",
      createdBy: "user-1",
      priority: 7,
    });
  });
});
