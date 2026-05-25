import { describe, expect, it } from "vitest";
import { planSkillCuratorTransition, type SkillCuratorCandidate } from "../../src/skills/curator";

function candidate(overrides: Partial<SkillCuratorCandidate>): SkillCuratorCandidate {
  return {
    id: "draft-1",
    slug: "operator-skill",
    status: "published",
    createdBy: "agent",
    curatorState: "active",
    curatorPinned: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    lastUsedAt: null,
    lastViewedAt: null,
    lastPatchedAt: null,
    ...overrides,
  };
}

describe("skill curator transitions", () => {
  const now = new Date("2026-04-15T00:00:00Z");

  it("marks idle agent-created skills stale before archiving", () => {
    expect(planSkillCuratorTransition(candidate({
      lastUsedAt: new Date("2026-03-01T00:00:00Z"),
    }), now, { staleAfterDays: 30, archiveAfterDays: 90 })).toBe("stale");
  });

  it("archives only after the archive cutoff", () => {
    expect(planSkillCuratorTransition(candidate({
      lastUsedAt: new Date("2026-01-01T00:00:00Z"),
    }), now, { staleAfterDays: 30, archiveAfterDays: 90 })).toBe("archived");
  });

  it("never auto-transitions pinned skills", () => {
    expect(planSkillCuratorTransition(candidate({
      curatorPinned: true,
      lastUsedAt: new Date("2026-01-01T00:00:00Z"),
    }), now, { staleAfterDays: 30, archiveAfterDays: 90 })).toBe("skip-pinned");
  });

  it("never auto-transitions user-owned skills", () => {
    expect(planSkillCuratorTransition(candidate({
      createdBy: "user",
      lastUsedAt: new Date("2026-01-01T00:00:00Z"),
    }), now, { staleAfterDays: 30, archiveAfterDays: 90 })).toBe("skip-user-owned");
  });
});
