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

vi.mock("../../../../notifications/sender", () => ({
  sendNotification: vi.fn(),
}));

import { canMutateHive } from "@/auth/users";
import { sendNotification } from "../../../../notifications/sender";
import { requireApiUser } from "../../_lib/auth";
import { sql } from "../../_lib/db";
import { POST } from "./route";

const mockCanMutateHive = canMutateHive as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockSendNotification = sendNotification as unknown as ReturnType<typeof vi.fn>;

describe("POST /api/notifications/test access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockCanMutateHive.mockResolvedValue(true);
  });

  it("returns 403 before sending when the caller cannot manage the hive", async () => {
    mockCanMutateHive.mockResolvedValueOnce(false);

    const response = await POST(new Request("http://localhost/api/notifications/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hiveId: "hive-1" }),
    }));

    expect(response.status).toBe(403);
    expect(mockCanMutateHive).toHaveBeenCalledWith(sql, "user-1", "hive-1");
    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});
