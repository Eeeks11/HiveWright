import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import {
  deriveOperatingProfileDefaults,
  getOperatingProfile,
  serializeOperatingProfileForPrompt,
  upsertOperatingProfile,
} from "../../src/hives/operating-profile";

async function insertHive(overrides: Partial<{
  name: string;
  slug: string;
  type: string;
  kind: string;
  description: string | null;
  mission: string | null;
}> = {}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO hives (name, slug, type, kind, description, mission)
    VALUES (
      ${overrides.name ?? "Test Hive"},
      ${overrides.slug ?? `test-hive-${Math.random().toString(36).slice(2, 8)}`},
      ${overrides.type ?? "digital"},
      ${overrides.kind ?? "business"},
      ${overrides.description ?? null},
      ${overrides.mission ?? null}
    )
    RETURNING id
  `;
  return row.id;
}

describe("operating profile domain", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("returns a derived fallback when an existing hive has no stored operating profile", async () => {
    const hiveId = await insertHive({
      name: "Kitchen Reno",
      kind: "personal_project",
      description: "Renovate the kitchen without overrunning budget.",
      mission: "Finish the renovation plan, contractor shortlist, and delivery schedule.",
    });

    const profile = await getOperatingProfile(sql, hiveId);

    expect(profile).not.toBeNull();
    if (!profile) throw new Error("expected operating profile");
    expect(profile).toMatchObject({
      hiveId,
      kind: "personal_project",
      isDerived: true,
      purpose: "Finish the renovation plan, contractor shortlist, and delivery schedule.",
    });
    expect(profile.desiredOutcome).toContain("Renovate the kitchen");
    expect(profile.approvalRules).toContain("Get owner approval before committing spend, changing scope, or contacting external parties.");
    expect(profile.kindProfile).toMatchObject({
      milestones: expect.arrayContaining(["Define deliverables", "Identify blockers", "Ship the next useful artifact"]),
    });
  });

  it("upserts a normalized owner-defined profile and reads it back as stored state", async () => {
    const hiveId = await insertHive({ kind: "business", mission: "Grow owner-approved consulting revenue." });

    const saved = await upsertOperatingProfile(sql, hiveId, {
      purpose: "Grow consulting revenue without taking unapproved client commitments.",
      desiredOutcome: "Reach $8k monthly revenue from two retained customers.",
      current30DayOutcome: "Validate the offer and book three qualified calls.",
      constraints: ["Owner works 6 hours/week", "  ", "Do not promise delivery dates before approval"],
      approvalRules: ["Owner approval required before quoting or discounting."],
      forbiddenActions: ["Do not send contracts without owner approval."],
      importantContext: ["Target buyers are local service businesses."],
      successCriteria: ["At least two qualified customer conversations"],
      stopOrPauseCriteria: ["Pause if outreach generates legal/compliance concerns."],
      kindProfile: {
        offer: "Operations consulting",
        pricing: "Monthly retainer",
        ignoredEmptyList: ["", "  "],
      },
    });

    const profile = await getOperatingProfile(sql, hiveId);

    expect(saved.isDerived).toBe(false);
    expect(profile).toMatchObject({
      hiveId,
      kind: "business",
      isDerived: false,
      purpose: "Grow consulting revenue without taking unapproved client commitments.",
      current30DayOutcome: "Validate the offer and book three qualified calls.",
      constraints: ["Owner works 6 hours/week", "Do not promise delivery dates before approval"],
      approvalRules: ["Owner approval required before quoting or discounting."],
      forbiddenActions: ["Do not send contracts without owner approval."],
      kindProfile: {
        offer: "Operations consulting",
        pricing: "Monthly retainer",
      },
    });
  });

  it("serializes a bounded safe prompt/display shape without dumping oversized JSON", () => {
    const profile = deriveOperatingProfileDefaults({
      hiveId: "hive-1",
      name: "Admin Helper",
      kind: "personal_assistant",
      description: "Handle admin prep.",
      mission: "Prepare recurring life admin without taking sensitive actions.",
      initialGoal: "Create a weekly admin checklist.",
      safetyPreset: "owner_review_first",
    });

    const block = serializeOperatingProfileForPrompt({
      ...profile,
      importantContext: Array.from({ length: 20 }, (_, i) => `Context item ${i}`),
      kindProfile: {
        recurringDuties: Array.from({ length: 20 }, (_, i) => `Duty ${i}`),
      },
    });

    expect(block).toContain("**Operating Profile:** personal_assistant");
    expect(block).toContain("Prepare recurring life admin");
    expect(block).toContain("External or sensitive actions require owner approval before execution.");
    expect(block).toContain("- Context item 0");
    expect(block).not.toContain("Context item 10");
    expect(block).not.toContain("Duty 19");
  });
});
