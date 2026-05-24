import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("../../../_lib/auth", () => ({
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: vi.fn(),
}));

vi.mock("@/hives/records", () => ({
  createManualHiveRecord: vi.fn(),
  getHiveRecordOptions: vi.fn(),
  listRecentHiveRecords: vi.fn(),
}));

import { canAccessHive } from "@/auth/users";
import {
  createManualHiveRecord,
  getHiveRecordOptions,
  listRecentHiveRecords,
} from "@/hives/records";
import { requireApiUser } from "../../../_lib/auth";
import { sql } from "../../../_lib/db";
import { GET, POST } from "./route";

const mockCanAccessHive = canAccessHive as unknown as ReturnType<typeof vi.fn>;
const mockCreateManualHiveRecord = createManualHiveRecord as unknown as ReturnType<typeof vi.fn>;
const mockGetHiveRecordOptions = getHiveRecordOptions as unknown as ReturnType<typeof vi.fn>;
const mockListRecentHiveRecords = listRecentHiveRecords as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

const params = { params: Promise.resolve({ id: "hive-1" }) };

function postRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/hives/hive-1/records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/hives/[id]/records", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockCanAccessHive.mockResolvedValue(true);
    mockGetHiveRecordOptions.mockReturnValue({
      kind: "research",
      familyOptions: [{ value: "evidence", label: "Evidence" }],
      typeOptions: [{ value: "finding", label: "Finding", family: "evidence" }],
      emptyState: "Add research records or goals.",
    });
    mockListRecentHiveRecords.mockResolvedValue([
      { id: "record-1", hiveId: "hive-1", type: "finding", title: "Initial finding" },
    ]);
    mockCreateManualHiveRecord.mockResolvedValue({
      id: "record-2",
      hiveId: "hive-1",
      sourceConnector: "manual",
      externalId: "manual_abc",
      family: "evidence",
      type: "finding",
      title: "Manual finding",
    });
  });

  it("returns 401 before DB use for signed-out callers", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(new Request("http://localhost/api/hives/hive-1/records"), params);

    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockCanAccessHive).not.toHaveBeenCalled();
  });

  it("returns recent records and kind-aware options for accessible hives", async () => {
    mockSql.mockResolvedValueOnce([{ id: "hive-1", kind: "research" }]);

    const res = await GET(new Request("http://localhost/api/hives/hive-1/records"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      records: [{ id: "record-1", hiveId: "hive-1", type: "finding", title: "Initial finding" }],
      options: expect.objectContaining({
        kind: "research",
        typeOptions: [{ value: "finding", label: "Finding", family: "evidence" }],
      }),
    });
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "user-1", "hive-1");
    expect(mockListRecentHiveRecords).toHaveBeenCalledWith(mockSql, "hive-1", {
      limit: 25,
      hiveKind: "research",
    });
  });

  it("returns 403 when a non-owner cannot access the hive", async () => {
    mockSql.mockResolvedValueOnce([{ id: "hive-1", kind: "research" }]);
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request("http://localhost/api/hives/hive-1/records"), params);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/hive access required/i);
    expect(mockListRecentHiveRecords).not.toHaveBeenCalled();
  });

  it("allows system owners to post a manual record without membership lookup", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mockSql.mockResolvedValueOnce([{ id: "hive-1", kind: "research" }]);

    const res = await POST(postRequest({
      family: "evidence",
      type: "finding",
      title: "Manual finding",
      summary: "Owner-entered note",
      occurredAt: "2026-05-20T00:00:00.000Z",
    }), params);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data).toMatchObject({ id: "record-2", sourceConnector: "manual" });
    expect(mockCanAccessHive).not.toHaveBeenCalled();
    expect(mockCreateManualHiveRecord).toHaveBeenCalledWith(mockSql, expect.objectContaining({
      hiveId: "hive-1",
      hiveKind: "research",
      family: "evidence",
      type: "finding",
      title: "Manual finding",
    }));
  });

  it("returns 400 for invalid manual record payloads", async () => {
    mockSql.mockResolvedValueOnce([{ id: "hive-1", kind: "research" }]);
    mockCreateManualHiveRecord.mockRejectedValueOnce(new Error("record type sale is not available for research hives"));

    const res = await POST(postRequest({
      family: "finance",
      type: "sale",
      title: "Wrong kind",
    }), params);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("record type sale is not available for research hives");
  });
});
