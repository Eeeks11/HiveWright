import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLoadCredentials } = vi.hoisted(() => ({ mockLoadCredentials: vi.fn() }));
vi.mock("@/credentials/manager", () => ({ loadCredentials: mockLoadCredentials }));

import { loadGoalSupervisorCredentials } from "@/goals/supervisor-env";

const originalEncryptionKey = process.env.ENCRYPTION_KEY;

beforeEach(() => {
  mockLoadCredentials.mockReset();
  process.env.ENCRYPTION_KEY = "dispatcher-only-encryption-key";
});

afterEach(() => {
  if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalEncryptionKey;
});

describe("goal supervisor scoped credentials", () => {
  it("requests only the hive/role-scoped internal bearer from the existing loader", async () => {
    mockLoadCredentials.mockResolvedValue({ INTERNAL_SERVICE_TOKEN: "scoped-supervisor-token" });
    const sql = vi.fn() as never;

    await expect(loadGoalSupervisorCredentials(sql, {
      goalId: "goal-security",
      hiveId: "hive-security",
    })).resolves.toEqual({ INTERNAL_SERVICE_TOKEN: "scoped-supervisor-token" });

    expect(mockLoadCredentials).toHaveBeenCalledWith(sql, expect.objectContaining({
      hiveId: "hive-security",
      roleSlug: "goal-supervisor",
      requiredKeys: ["INTERNAL_SERVICE_TOKEN"],
      encryptionKey: "dispatcher-only-encryption-key",
      auditContext: expect.objectContaining({ goalId: "goal-security", hiveId: "hive-security" }),
    }));
  });

  it("does not query encrypted credentials when the dispatcher lacks its encryption key", async () => {
    delete process.env.ENCRYPTION_KEY;
    await expect(loadGoalSupervisorCredentials(vi.fn() as never, {
      goalId: "goal-security",
      hiveId: "hive-security",
    })).resolves.toEqual({});
    expect(mockLoadCredentials).not.toHaveBeenCalled();
  });
});
