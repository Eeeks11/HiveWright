import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/app/api/_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("@/app/api/_lib/auth", () => ({
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: vi.fn(),
}));

import { GET as getHive } from "@/app/api/hives/[id]/route";
import { GET as searchMemory } from "@/app/api/memory/search/route";
import { GET as getTimeline } from "@/app/api/memory/timeline/route";
import { GET as listBoardSessions } from "@/app/api/board/sessions/route";
import { GET as getBoardSession } from "@/app/api/board/sessions/[id]/route";
import { sql } from "@/app/api/_lib/db";
import { requireApiUser } from "@/app/api/_lib/auth";
import { canAccessHive } from "@/auth/users";

const mockSql = vi.mocked(sql) as unknown as Mock;
const mockRequireApiUser = vi.mocked(requireApiUser);
const mockCanAccessHive = vi.mocked(canAccessHive);

const HIVE_A_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

const memberUser = {
  id: "user-1",
  email: "member@example.com",
  isSystemOwner: false,
};

const hiveRow = {
  id: HIVE_A_ID,
  slug: "hive-a",
  name: "Hive A",
  type: "digital",
  kind: "business",
  operating_mode: "active",
  description: null,
  mission: null,
  workspace_path: "/tmp/hive-a",
  is_system_fixture: false,
  created_at: "2026-04-27T00:00:00.000Z",
};

const boardSessionRow = {
  id: SESSION_ID,
  hive_id: HIVE_A_ID,
  question: "What next?",
  status: "completed",
  recommendation: "Proceed",
  error_text: null,
  created_at: "2026-04-27T00:00:00.000Z",
  completed_at: "2026-04-27T00:01:00.000Z",
};

function authAsMember() {
  mockRequireApiUser.mockResolvedValue({ user: memberUser });
}

async function expectForbidden(response: Response) {
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({
    error: expect.stringMatching(/Forbidden:/),
  });
}

function requestWithHive(path: string): Request {
  return new Request(`http://localhost${path}${path.includes("?") ? "&" : "?"}hiveId=${HIVE_A_ID}`);
}

describe("cross-hive read route auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authAsMember();
    mockCanAccessHive.mockResolvedValue(true);
  });

  it("GET /api/hives/[id] denies an authenticated non-member", async () => {
    mockSql.mockResolvedValueOnce([hiveRow]);
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await getHive(
      new Request(`http://localhost/api/hives/${HIVE_A_ID}`),
      { params: Promise.resolve({ id: HIVE_A_ID }) },
    );

    await expectForbidden(res as unknown as Response);
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "user-1", HIVE_A_ID);
  });

  it("GET /api/hives/[id] allows an authorized member", async () => {
    mockSql
      .mockResolvedValueOnce([hiveRow])
      .mockResolvedValueOnce([{
        id: hiveRow.id,
        name: hiveRow.name,
        kind: hiveRow.kind,
        description: hiveRow.description,
        mission: hiveRow.mission,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await getHive(
      new Request(`http://localhost/api/hives/${HIVE_A_ID}`),
      { params: Promise.resolve({ id: HIVE_A_ID }) },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: { id: HIVE_A_ID, name: "Hive A" },
    });
  });

  it("GET /api/memory/search denies an authenticated non-member before memory queries", async () => {
    mockSql.mockResolvedValueOnce([hiveRow]);
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await searchMemory(
      requestWithHive("/api/memory/search?q=needle"),
    );

    await expectForbidden(res as unknown as Response);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("GET /api/memory/search allows an authorized member", async () => {
    mockSql.mockResolvedValueOnce([hiveRow]).mockResolvedValue([]);

    const res = await searchMemory(
      requestWithHive("/api/memory/search?q=needle"),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ data: [] });
    expect(mockSql).toHaveBeenCalledTimes(4);
  });

  it("GET /api/memory/timeline denies an authenticated non-member before timeline queries", async () => {
    mockSql.mockResolvedValueOnce([hiveRow]);
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await getTimeline(
      requestWithHive("/api/memory/timeline"),
    );

    await expectForbidden(res as unknown as Response);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("GET /api/memory/timeline allows an authorized member", async () => {
    mockSql.mockResolvedValueOnce([hiveRow]).mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);

    const res = await getTimeline(
      requestWithHive("/api/memory/timeline?store=role_memory"),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
  });

  it("GET /api/board/sessions denies an authenticated non-member before listing sessions", async () => {
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await listBoardSessions(
      requestWithHive("/api/board/sessions"),
    );

    await expectForbidden(res as unknown as Response);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("GET /api/board/sessions allows an authorized member", async () => {
    mockSql.mockResolvedValueOnce([boardSessionRow]);

    const res = await listBoardSessions(
      requestWithHive("/api/board/sessions"),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: [{ id: SESSION_ID, question: "What next?" }],
    });
  });

  it("GET /api/board/sessions/[id] denies an authenticated non-member after resolving the session hive", async () => {
    mockSql.mockResolvedValueOnce([hiveRow]);
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await getBoardSession(
      requestWithHive(`/api/board/sessions/${SESSION_ID}`),
      { params: Promise.resolve({ id: SESSION_ID }) },
    );

    await expectForbidden(res as unknown as Response);
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "user-1", HIVE_A_ID);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("GET /api/board/sessions/[id] allows an authorized member", async () => {
    mockSql.mockResolvedValueOnce([hiveRow]).mockResolvedValueOnce([boardSessionRow]).mockResolvedValueOnce([]);

    const res = await getBoardSession(
      requestWithHive(`/api/board/sessions/${SESSION_ID}`),
      { params: Promise.resolve({ id: SESSION_ID }) },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: { session: { id: SESSION_ID, hive_id: HIVE_A_ID }, turns: [] },
    });
  });

  it("returns 401 before DB access when direct imports are unauthenticated", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const res = await getBoardSession(
      requestWithHive(`/api/board/sessions/${SESSION_ID}`),
      { params: Promise.resolve({ id: SESSION_ID }) },
    );

    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockCanAccessHive).not.toHaveBeenCalled();
  });
});
