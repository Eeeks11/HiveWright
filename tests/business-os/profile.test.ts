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

function buildNewBusinessRequest(slug: string): HiveSetupRequest {
  return buildRequest(slug, {
    hive: {
      name: "Launch Co",
      slug,
      type: "digital",
      kind: "business",
      description: "Launch a local services business",
      mission: "Create a launch-ready operating model with governed ops",
    },
    businessOs: {
      mode: "new_business",
      profile: {
        businessName: "Launch Co",
        industry: "local services",
        stage: "pre_launch",
        ownerGoals: ["Validate the first offer within 30 days"],
        constraints: ["Small AI spend budget", "No public launch actions without approval"],
        aiSpendBudget: { window: "monthly", capCents: 15000 },
      },
      setup: {
        idea: "A weekend maintenance service for busy property owners",
        feasibilityRisks: ["Owner availability is limited", "Insurance needs confirmation"],
        customerSegments: ["Time-poor property owners"],
        problemStatements: ["Small maintenance jobs do not get handled quickly"],
        offers: ["Monthly maintenance checkup"],
        pricingModel: { model: "subscription", startingPriceCents: 19900 },
        businessBlueprint: {
          offer: "Monthly maintenance checkup",
          customer: "Time-poor property owners",
          pricing: "Subscription from $199",
        },
        marketingModel: { channels: ["local referral partners", "Google Business Profile"] },
        salesModel: { motion: "owner-led consult call" },
        deliveryModel: { fulfilment: "scheduled local service visits" },
        adminFinanceModel: { bookkeeping: "set up separate bookkeeping and payment workflow" },
        legalComplianceChecklist: ["Confirm licensing and insurance requirements"],
        toolStack: ["booking calendar", "invoicing", "CRM"],
        rolesAndSops: ["intake SOP", "site visit checklist"],
        launchReadiness: ["Insurance confirmed", "Offer package approved", "Finance/admin checklist complete"],
        launchRoadmap: ["Validate customer/problem", "Package the first offer", "Draft launch assets"],
        launchActions: ["Publish first public offer", "Start paid local ads"],
        initialLoops: ["Weekly launch readiness review", "Lead follow-up loop"],
      },
    },
    safetyPreset: "owner_review_first",
  });
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

  it("turns a new-business setup intake into structured operating state and an action queue", async () => {
    const fixture = createFixtureNamespace("business-os-new-setup");
    const slug = fixture.slug("new-business-setup");
    const result = await runHiveSetup(sql, buildNewBusinessRequest(slug));

    const [setupProfile] = await sql<{
      idea: string;
      customer_segments: string[];
      offers: string[];
      pricing_model: Record<string, unknown>;
      brand_positioning: Record<string, unknown>;
    }[]>`
      SELECT idea, customer_segments, offers, pricing_model, brand_positioning
      FROM business_setup_profiles
      WHERE hive_id = ${result.id}::uuid
    `;

    expect(setupProfile).toMatchObject({
      idea: "A weekend maintenance service for busy property owners",
      customer_segments: ["Time-poor property owners"],
      offers: ["Monthly maintenance checkup"],
      pricing_model: { model: "subscription", startingPriceCents: 19900 },
      brand_positioning: {
        feasibilityRisks: ["Owner availability is limited", "Insurance needs confirmation"],
        businessBlueprint: {
          offer: "Monthly maintenance checkup",
          customer: "Time-poor property owners",
          pricing: "Subscription from $199",
        },
        launchReadiness: ["Insurance confirmed", "Offer package approved", "Finance/admin checklist complete"],
        launchRoadmap: ["Validate customer/problem", "Package the first offer", "Draft launch assets"],
        launchActions: ["Publish first public offer", "Start paid local ads"],
        initialLoops: ["Weekly launch readiness review", "Lead follow-up loop"],
      },
    });

    const readinessRows = await sql<{ system_key: string; source_kind: string; readiness_score: number; confidence: string }[]>`
      SELECT system_key, source_kind, readiness_score, confidence
      FROM business_system_readiness
      WHERE hive_id = ${result.id}::uuid
      ORDER BY system_key ASC
    `;
    expect(readinessRows.length).toBeGreaterThanOrEqual(10);
    expect(readinessRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ system_key: "customer_market", source_kind: "setup" }),
      expect.objectContaining({ system_key: "offer_pricing", source_kind: "setup" }),
      expect.objectContaining({ system_key: "ai_governance", source_kind: "setup" }),
    ]));

    const gaps = await sql<{ title: string; gap_type: string; severity: string; status: string }[]>`
      SELECT title, gap_type, severity, status
      FROM business_gaps
      WHERE hive_id = ${result.id}::uuid
      ORDER BY title ASC
    `;
    expect(gaps.length).toBeGreaterThanOrEqual(5);
    expect(gaps.every((gap) => gap.status === "open")).toBe(true);

    const actions = await sql<{
      title: string;
      status: string;
      approval_required: boolean;
      risk_level: string;
      expected_outcome: string | null;
      measurement_plan: Record<string, unknown>;
    }[]>`
      SELECT title, status, approval_required, risk_level, expected_outcome, measurement_plan
      FROM business_actions
      WHERE hive_id = ${result.id}::uuid
      ORDER BY priority DESC, title ASC
    `;
    expect(actions.length).toBeGreaterThanOrEqual(5);
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: expect.stringMatching(/validate/i), status: "queued", approval_required: false }),
      expect.objectContaining({ title: expect.stringMatching(/launch approval/i), status: "awaiting_approval", approval_required: true, risk_level: "high" }),
    ]));
    expect(actions.every((action) => action.expected_outcome && Object.keys(action.measurement_plan).length > 0)).toBe(true);

    const unsafeActions = actions.filter((action) => action.risk_level === "high");
    expect(unsafeActions.length).toBeGreaterThan(0);
    expect(unsafeActions.every((action) => action.approval_required && action.status === "awaiting_approval")).toBe(true);
  });

  it("turns an existing-business audit intake into evidence-backed readiness, gaps, recommendations, and actions", async () => {
    const fixture = createFixtureNamespace("business-os-existing-audit");
    const slug = fixture.slug("existing-business-audit");
    const result = await runHiveSetup(sql, buildRequest(slug, {
      businessOs: {
        mode: "existing_business",
        profile: {
          businessName: "Whiston-style Ops Co",
          industry: "property services",
          stage: "operating",
          ownerGoals: ["Make the business agent-ready without risking customer trust"],
          constraints: ["No public, spend, or customer-facing actions without owner approval"],
          aiSpendBudget: { window: "monthly", capCents: 20000 },
        },
        audit: {
          scope: ["strategy_governance", "marketing_attention", "sales_conversion", "finance_admin", "ai_governance"],
          evidenceSources: [
            { kind: "manual", label: "Owner notes", summary: "Current work is mostly owner-memory and ad hoc tools." },
            { kind: "structured_state", label: "Existing marketing/sales modules", summary: "Marketing and sales foundations exist but are not yet connected to an audit loop." },
          ],
          knownUnknowns: ["No verified finance/admin system evidence supplied", "No SOP library evidence supplied"],
        },
      },
    }));

    const [auditProfile] = await sql<{
      audit_status: string;
      audit_scope: string[];
      evidence_sources: Array<Record<string, unknown>>;
      known_unknowns: string[];
      overall_readiness_score: number;
      overall_confidence: string;
    }[]>`
      SELECT audit_status, audit_scope, evidence_sources, known_unknowns, overall_readiness_score, overall_confidence
      FROM business_audit_profiles
      WHERE hive_id = ${result.id}::uuid
    `;

    expect(auditProfile).toMatchObject({
      audit_status: "completed",
      audit_scope: expect.arrayContaining(["strategy_governance", "marketing_attention", "sales_conversion", "finance_admin", "ai_governance"]),
      overall_confidence: "medium",
    });
    expect(auditProfile.overall_readiness_score).toBeGreaterThan(0);
    expect(auditProfile.evidence_sources.length).toBeGreaterThanOrEqual(2);
    expect(auditProfile.known_unknowns).toContain("No verified finance/admin system evidence supplied");

    const readinessRows = await sql<{
      system_key: string;
      source_kind: string;
      readiness_score: number;
      confidence: string;
      evidence_refs: Array<Record<string, unknown>>;
    }[]>`
      SELECT system_key, source_kind, readiness_score, confidence, evidence_refs
      FROM business_system_readiness
      WHERE hive_id = ${result.id}::uuid
      ORDER BY system_key ASC
    `;
    expect(readinessRows.length).toBeGreaterThanOrEqual(10);
    expect(readinessRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ system_key: "marketing_attention", source_kind: "audit" }),
      expect.objectContaining({ system_key: "sales_conversion", source_kind: "audit" }),
      expect.objectContaining({ system_key: "software_integrations_data", source_kind: "audit" }),
      expect.objectContaining({ system_key: "ai_governance", source_kind: "audit" }),
    ]));
    expect(readinessRows.every((row) => row.evidence_refs.length > 0)).toBe(true);

    const gaps = await sql<{ title: string; gap_type: string; severity: string; confidence: string; evidence_refs: Array<Record<string, unknown>> }[]>`
      SELECT title, gap_type, severity, confidence, evidence_refs
      FROM business_gaps
      WHERE hive_id = ${result.id}::uuid
      ORDER BY severity DESC, title ASC
    `;
    expect(gaps.length).toBeGreaterThanOrEqual(5);
    expect(gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: expect.stringMatching(/agent-ready operating model/i), severity: "high" }),
      expect.objectContaining({ title: expect.stringMatching(/finance/i), gap_type: "missing_data" }),
    ]));
    expect(gaps.every((gap) => gap.confidence && gap.evidence_refs.length > 0)).toBe(true);

    const recommendations = await sql<{ title: string; status: string; requires_owner_approval: boolean }[]>`
      SELECT title, status, requires_owner_approval
      FROM business_recommendations
      WHERE hive_id = ${result.id}::uuid
    `;
    expect(recommendations.length).toBeGreaterThanOrEqual(5);
    expect(recommendations.every((recommendation) => recommendation.status === "converted_to_action")).toBe(true);

    const actions = await sql<{
      title: string;
      status: string;
      approval_required: boolean;
      risk_level: string;
      measurement_plan: Record<string, unknown>;
    }[]>`
      SELECT title, status, approval_required, risk_level, measurement_plan
      FROM business_actions
      WHERE hive_id = ${result.id}::uuid
      ORDER BY priority DESC, title ASC
    `;
    expect(actions.length).toBeGreaterThanOrEqual(5);
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: expect.stringMatching(/audit improvement/i), status: "queued" }),
      expect.objectContaining({ title: expect.stringMatching(/owner approval/i), status: "awaiting_approval", approval_required: true, risk_level: "high" }),
    ]));
    expect(actions.every((action) => Object.keys(action.measurement_plan).length > 0)).toBe(true);
    expect(actions.filter((action) => action.risk_level === "high").every((action) => action.approval_required && action.status === "awaiting_approval")).toBe(true);
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
