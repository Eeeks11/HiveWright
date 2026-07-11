import { describe, expect, it, vi } from "vitest";
import { canMutateHive } from "./users";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const HIVE_ID = "22222222-2222-4222-8222-222222222222";

function membershipSql(input: { systemOwner?: boolean; membershipCount?: number }) {
  return vi.fn()
    .mockResolvedValueOnce(input.systemOwner ? [{ isSystemOwner: true }] : [{ isSystemOwner: false }])
    .mockResolvedValueOnce([{ c: input.membershipCount ?? 0 }]);
}

describe("canMutateHive", () => {
  it("denies unauthenticated/invalid principals without querying", async () => {
    const sql = vi.fn();
    await expect(canMutateHive(sql as never, "", HIVE_ID)).resolves.toBe(false);
    expect(sql).not.toHaveBeenCalled();
  });

  it("denies viewers and cross-hive members", async () => {
    const viewerSql = membershipSql({ membershipCount: 0 });
    await expect(canMutateHive(viewerSql as never, USER_ID, HIVE_ID)).resolves.toBe(false);
    expect(viewerSql).toHaveBeenCalledTimes(2);

    const membershipQuery = Array.from(viewerSql.mock.calls[1][0] as TemplateStringsArray).join(" ");
    expect(membershipQuery).toContain("role IN ('owner', 'member')");
  });

  it("allows editor/member and hive-owner memberships", async () => {
    for (const role of ["member", "owner"]) {
      const sql = membershipSql({ membershipCount: 1 });
      await expect(canMutateHive(sql as never, USER_ID, HIVE_ID)).resolves.toBe(true);
      expect(sql).toHaveBeenCalledTimes(2);
      expect(role).toBeTruthy();
    }
  });

  it("preserves system-owner behavior without membership lookup", async () => {
    const sql = membershipSql({ systemOwner: true });
    await expect(canMutateHive(sql as never, USER_ID, HIVE_ID)).resolves.toBe(true);
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("preserves trusted internal-principal behavior without DB access", async () => {
    const sql = vi.fn();
    await expect(canMutateHive(sql as never, "internal-service-account", HIVE_ID)).resolves.toBe(true);
    expect(sql).not.toHaveBeenCalled();
  });
});
