import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("../../../../_lib/auth", () => ({
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canMutateHive: vi.fn(),
}));

vi.mock("@/hives/records", () => ({
  importHiveRecordsFromCsv: vi.fn(),
  MAX_CSV_IMPORT_BYTES: 250_000,
}));

import { canMutateHive } from "@/auth/users";
import { importHiveRecordsFromCsv } from "@/hives/records";
import { requireApiUser } from "../../../../_lib/auth";
import { sql } from "../../../../_lib/db";
import { POST } from "./route";

const mockCanMutateHive = canMutateHive as unknown as ReturnType<typeof vi.fn>;
const mockImportHiveRecordsFromCsv = importHiveRecordsFromCsv as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

const params = { params: Promise.resolve({ id: "hive-1" }) };

function csvRequest(csvText: string, filename = "records.csv") {
  const formData = new FormData();
  formData.append("file", new File([csvText], filename, { type: "text/csv" }));
  return new Request("http://localhost/api/hives/hive-1/records/import", {
    method: "POST",
    body: formData,
  });
}

describe("/api/hives/[id]/records/import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockCanMutateHive.mockResolvedValue(true);
    mockImportHiveRecordsFromCsv.mockResolvedValue({
      imported: 1,
      rejected: 1,
      errors: [{ rowNumber: 3, message: "title is required" }],
      records: [{ id: "record-1", hiveId: "hive-1", type: "finding", title: "Imported finding" }],
    });
  });

  it("returns 401 before DB use for signed-out callers", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await POST(csvRequest("type,title\nfinding,Imported finding"), params);

    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockCanMutateHive).not.toHaveBeenCalled();
    expect(mockImportHiveRecordsFromCsv).not.toHaveBeenCalled();
  });

  it("requires hive access and imports with the persisted hive kind", async () => {
    mockSql.mockResolvedValueOnce([{ id: "hive-1", kind: "research" }]);

    const res = await POST(csvRequest("type,title\nfinding,Imported finding"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      imported: 1,
      rejected: 1,
      errors: [{ rowNumber: 3, message: "title is required" }],
      records: [{ id: "record-1", hiveId: "hive-1", type: "finding", title: "Imported finding" }],
    });
    expect(mockCanMutateHive).toHaveBeenCalledWith(mockSql, "user-1", "hive-1");
    expect(mockImportHiveRecordsFromCsv).toHaveBeenCalledWith(mockSql, expect.objectContaining({
      hiveId: "hive-1",
      hiveKind: "research",
      csvText: "type,title\nfinding,Imported finding",
      filename: "records.csv",
    }));
  });

  it("returns 403 without importing when the user cannot access the hive", async () => {
    mockSql.mockResolvedValueOnce([{ id: "hive-1", kind: "business" }]);
    mockCanMutateHive.mockResolvedValueOnce(false);

    const res = await POST(csvRequest("type,title\nsale,Invoice paid"), params);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/hive mutation access required/i);
    expect(mockImportHiveRecordsFromCsv).not.toHaveBeenCalled();
  });

  it("rejects missing files and oversized CSV uploads", async () => {
    mockSql.mockResolvedValue([{ id: "hive-1", kind: "business" }]);

    const emptyForm = new FormData();
    const missing = await POST(new Request("http://localhost/api/hives/hive-1/records/import", {
      method: "POST",
      body: emptyForm,
    }), params);
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toMatch(/CSV file is required/i);

    const oversized = await POST(csvRequest("x".repeat(260_001)), params);
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).error).toMatch(/CSV payload is too large/i);
    expect(mockImportHiveRecordsFromCsv).not.toHaveBeenCalled();
  });
});
