import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureNamespace, testSql as sql, truncateAll } from "../_lib/test-db";
import {
  BUSINESS_MODES,
  normalizeBusinessMode,
  upsertBusinessOsProfile,
} from "@/business-os/profile";
import { getOperatingProfile, serializeOperatingProfileForPrompt } from "@/hives/operating-profile";
import { runHiveSetup, type HiveSetupRequest } from "@/hives/setup";

let workspaceRoot = "";
const originalEncryptionKey = process.env.ENCRYPTION_KEY;
const originalWorkspaceRoot = process.env.HIVES_WORKSPACE_ROOT;

function buildRequest(slug: string, overrides: Partial<HiveSetupRequest> = {}): HiveSetupRequest {
  return {
    hive: {
      name: "Business OS Hive",
      slug,
      type: "digital",
      kind: "business",
      description: "Business OS setup coverage",
      mission: "Run the business with governed ops",
    },
    businessOs: {
      mode: "existing_business",
      profile: {
        businessName: "Existing Co",
        industry: "professional services",
        stage: "operating",
        summary: "Improve the current operating model.",
        ownerGoals: ["Increase qualified demand"],
        constraints: ["No public or spend actions without approval"],
        aiSpendBudget: { window: "monthly", capCents: 25000 },
      },
    },
    safetyPreset: "owner_review_first",
    ...overrides,
  };
}

async function insertHive(slug: string, kind = "business") {
  const [hive] = await sql<{ id: string }[]>`
    INSERT INTO hives (name, slug, type, kind, operating_mode)
    VALUES ('Business OS Direct Hive', ${slug}, 'digital', ${kind}, 'exploring')
    RETURNING id
  `;
  return hive.id;
}

describe("Business OS profile foundation", () => {
  beforeEach(async () => {
    await truncateAll(sql);
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hw-business-os-"));
    process.env.ENCRYPTION_KEY = "test-encryption-key";
    process.env.HIVES_WORKSPACE_ROOT = workspaceRoot;
  });

  afterEach(() => {
    process.env.ENCRYPTION_KEY = originalEncryptionKey;
    if (originalWorkspaceRoot === undefined) {
      delete process.env.HIVES_WORKSPACE_ROOT;
    } else {
      process.env.HIVES_WORKSPACE_ROOT = originalWorkspaceRoot;
    }
    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = "";
    }
  });

  it("validates the first launch Business OS modes", () => {
    expect(BUSINESS_MODES).toEqual(["new_business", "existing_business"]);
    expect(normalizeBusinessMode("new_business")).toBe("new_business");
    expect(normalizeBusinessMode("existing_business")).toBe("existing_business");
    expect(normalizeBusinessMode("business_unit")).toBe("new_business");
    expect(normalizeBusinessMode(null)).toBe("new_business");
  });

  it("upserts one hive-scoped profile with conservative owner approval defaults", async () => {
    const fixture = createFixtureNamespace("business-os-profile-upsert");
    const hiveId = await insertHive(fixture.slug("business-os-profile"));

    const profile = await upsertBusinessOsProfile(sql, hiveId, {
      mode: "existing_business",
      businessName: "Ops Co",
      industry: "trades",
      stage: "operating",
      summary: "Audit the current business.",
      ownerGoals: ["Find gaps"],
      constraints: ["Keep customer trust safe"],
      aiSpendBudget: { capCents: 10000, window: "monthly" },
      sourceProfile: { setup: "wizard" },
    });

    expect(profile).toMatchObject({
      hiveId,
      businessMode: "existing_business",
      businessName: "Ops Co",
      industry: "trades",
      stage: "operating",
      ownerGoals: ["Find gaps"],
      constraints: ["Keep customer trust safe"],
      approvalPolicy: expect.objectContaining({ defaultPreset: "owner_review_first" }),
      autonomyPolicy: expect.objectContaining({ externalActions: "owner_approval_required" }),
    });

    await upsertBusinessOsProfile(sql, hiveId, {
      mode: "new_business",
      businessName: "New Ops Co",
    });

    const rows = await sql<{ business_mode: string; business_name: string }[]>`
      SELECT business_mode, business_name FROM business_os_profiles WHERE hive_id = ${hiveId}::uuid
    `;
    expect(rows).toEqual([{ business_mode: "new_business", business_name: "New Ops Co" }]);
  });

  it("persists a Business OS profile during business hive setup and feeds runtime context", async () => {
    const fixture = createFixtureNamespace("business-os-setup");
    const slug = fixture.slug("business-os-setup");
    const result = await runHiveSetup(sql, buildRequest(slug));

    const [profile] = await sql<{
      hive_id: string;
      business_mode: string;
      business_name: string;
      industry: string | null;
      stage: string | null;
      approval_policy: Record<string, unknown>;
      ai_spend_budget: Record<string, unknown>;
      autonomy_policy: Record<string, unknown>;
    }[]>`
      SELECT hive_id, business_mode, business_name, industry, stage, approval_policy, ai_spend_budget, autonomy_policy
      FROM business_os_profiles
      WHERE hive_id = ${result.id}::uuid
    `;

    expect(profile).toMatchObject({
      hive_id: result.id,
      business_mode: "existing_business",
      business_name: "Existing Co",
      industry: "professional services",
      stage: "operating",
      approval_policy: expect.objectContaining({ defaultPreset: "owner_review_first" }),
      ai_spend_budget: { window: "monthly", capCents: 25000 },
      autonomy_policy: expect.objectContaining({ externalActions: "owner_approval_required" }),
    });

    const operatingProfile = await getOperatingProfile(sql, result.id);
    expect(operatingProfile?.kindProfile).toMatchObject({
      businessMode: "existing_business",
      businessName: "Existing Co",
      businessOs: expect.objectContaining({ industry: "professional services" }),
    });
    expect(serializeOperatingProfileForPrompt(operatingProfile!)).toContain("businessMode: existing_business");
  });

  it("does not create Business OS state for non-business hives", async () => {
    const fixture = createFixtureNamespace("business-os-non-business");
    const result = await runHiveSetup(sql, buildRequest(fixture.slug("research-hive"), {
      hive: {
        name: "Research Hive",
        slug: fixture.slug("research-hive"),
        type: "digital",
        kind: "research",
      },
      businessOs: {
        mode: "existing_business",
        profile: { businessName: "Should not persist" },
      },
    }));

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM business_os_profiles WHERE hive_id = ${result.id}::uuid
    `;
    expect(rows).toEqual([]);
  });
});
