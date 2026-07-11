import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("../../_lib/auth", () => ({
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canMutateHive: vi.fn(),
}));

import { canMutateHive } from "@/auth/users";
import { requireApiUser } from "../../_lib/auth";
import { sql } from "../../_lib/db";
import { POST } from "./route";

const mockCanMutateHive = canMutateHive as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

function subscribeRequest(hiveId = "hive-1") {
  return new Request("http://localhost/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hiveId,
      subscription: {
        endpoint: "https://push.example/endpoint",
        keys: { p256dh: "p256dh", auth: "auth" },
      },
    }),
  });
}

describe("POST /api/push/subscribe access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockCanMutateHive.mockResolvedValue(true);
  });

  it("returns 403 before upserting when the caller cannot access the hive", async () => {
    mockCanMutateHive.mockResolvedValueOnce(false);

    const response = await POST(subscribeRequest());

    expect(response.status).toBe(403);
    expect(mockCanMutateHive).toHaveBeenCalledWith(mockSql, "user-1", "hive-1");
    expect(mockSql).not.toHaveBeenCalled();
  });
});
