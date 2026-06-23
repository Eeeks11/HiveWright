import { describe, expect, it } from "vitest";
import { createMarketingObjectiveDraft } from "@/marketing-os/foundation";
import { createSalesOperatingPlan } from "@/sales-os/foundation";
import {
  BUSINESS_SYSTEM_TEMPLATE_KEYS,
  BUSINESS_SYSTEM_TEMPLATES,
  buildBusinessSystemTemplateOutputs,
  mapMarketingOsToBusinessSystem,
  mapSalesOsToBusinessSystem,
} from "@/business-os/system-templates";

describe("Business OS system templates", () => {
  it("registers every reusable department/system template with criteria and actions for both business modes", () => {
    expect(BUSINESS_SYSTEM_TEMPLATE_KEYS).toEqual([
      "strategy_governance",
      "marketing_attention",
      "sales_conversion",
      "delivery_operations",
      "finance_admin",
      "customer_success_reviews_referrals",
      "people_roles_sops",
      "compliance_risk",
      "software_integrations_data",
      "ai_governance",
    ]);

    for (const template of BUSINESS_SYSTEM_TEMPLATES) {
      expect(template.supportedModes).toEqual(["new_business", "existing_business"]);
      expect(template.readinessCriteria.length).toBeGreaterThanOrEqual(3);
      expect(template.setupActionCandidates.length).toBeGreaterThanOrEqual(1);
      expect(template.auditActionCandidates.length).toBeGreaterThanOrEqual(1);
      expect(template.setupActionCandidates.every((action) => action.expectedOutcome && Object.keys(action.measurementPlan).length > 0)).toBe(true);
      expect(template.auditActionCandidates.every((action) => action.expectedOutcome && Object.keys(action.measurementPlan).length > 0)).toBe(true);
    }
  });

  it("turns templates into structured readiness, gaps, recommendations, and actions for new and existing business modes", () => {
    for (const mode of ["new_business", "existing_business"] as const) {
      const outputs = buildBusinessSystemTemplateOutputs(mode);
      expect(outputs).toHaveLength(BUSINESS_SYSTEM_TEMPLATES.length);
      expect(outputs.every((output) => output.readiness.criteria.length >= 3)).toBe(true);
      expect(outputs.every((output) => output.gaps.length >= 1)).toBe(true);
      expect(outputs.every((output) => output.recommendations.length >= 1)).toBe(true);
      expect(outputs.every((output) => output.actionCandidates.length >= 1)).toBe(true);
    }
  });

  it("maps Marketing OS campaign/asset state into Business OS readiness and approval-gated actions", () => {
    const marketing = createMarketingObjectiveDraft({
      hiveId: "hive-1",
      objective: "Launch first local offer",
      targetAudience: "Property owners",
      offer: "Monthly maintenance checkup",
      channels: ["ads", "social"],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const output = mapMarketingOsToBusinessSystem({
      campaigns: [{ ...marketing.campaign, spendBudgetCents: 50000 }],
      assets: marketing.assets,
      metricSnapshots: [],
    });

    expect(output.readiness.systemKey).toBe("marketing_attention");
    expect(output.readiness.summary).toContain("1 marketing campaign");
    expect(output.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ gapType: "approval_gap", severity: "high" }),
    ]));
    expect(output.actionCandidates[0]).toMatchObject({
      type: "approval_request",
      approvalRequired: true,
      riskLevel: "high",
    });
  });

  it("maps Sales OS funnel bottlenecks into Business OS gaps and measured actions", () => {
    const sales = createSalesOperatingPlan({
      hiveId: "hive-1",
      goal: "Improve lead conversion",
      segment: { name: "new enquiries", source: "manual_import", customerType: "lead" },
      metrics: {
        traffic: 100,
        leads: 80,
        responded: 20,
        qualified: 10,
        booked: 8,
        showed: 6,
        sold: 3,
        reviews: 0,
        referrals: 0,
        repeatPurchases: 0,
      },
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const output = mapSalesOsToBusinessSystem({
      funnel: sales.funnel,
      bottleneck: sales.bottleneck,
      actionPlan: sales.actionPlan,
    });

    expect(output.readiness.systemKey).toBe("sales_conversion");
    expect(output.readiness.confidence).toBe("high");
    expect(output.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ systemKey: "sales_conversion", gapType: "weak_process" }),
    ]));
    expect(output.actionCandidates[0]).toMatchObject({
      type: "approval_request",
      approvalRequired: true,
    });
    expect(output.actionCandidates[0].measurementPlan).toHaveProperty("baseline", sales.bottleneck.conversionRate);
  });
});
