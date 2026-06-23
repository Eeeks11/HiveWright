import { describe, expect, it } from "vitest";
import {
  buildImprovementScanEvidenceContract,
  validateImprovementScanPublicationEvidence,
  type ImprovementScanPromotedFindingEvidence,
} from "@/operations/improvement-scan-evidence";

const ANALYST_TELEMETRY_EVIDENCE = {
  endpoint: "/api/analyst-telemetry?hiveId=11111111-1111-4111-8111-111111111111",
  checkedAt: "2026-06-22T23:22:50.349Z",
  buildHash: "build-current",
  authoritativeFor: ["readiness", "model_routing", "runtime_drift"] as Array<"readiness" | "model_routing" | "runtime_drift">,
};

describe("improvement scan evidence gate", () => {
  it("allows route-affecting findings only when evidence is build-matched and authoritative", () => {
    const finding: ImprovementScanPromotedFindingEvidence = {
      findingId: "ready-route-capacity",
      actions: ["route_issue"],
      endpointFamily: "model_routing",
      endpointEvidence: [ANALYST_TELEMETRY_EVIDENCE],
    };

    expect(validateImprovementScanPublicationEvidence({
      publicationBuildHash: "build-current",
      promotedFindings: [finding],
    })).toEqual({
      ok: true,
      blockedFindingIds: [],
      reasons: [],
    });
  });

  it("blocks stale build evidence from reopening or routing readiness findings", () => {
    const finding: ImprovementScanPromotedFindingEvidence = {
      findingId: "stale-setup-readiness-warning",
      actions: ["reopen_issue"],
      endpointFamily: "readiness",
      endpointEvidence: [
        {
          ...ANALYST_TELEMETRY_EVIDENCE,
          buildHash: "build-before-refresh",
        },
      ],
    };

    const result = validateImprovementScanPublicationEvidence({
      publicationBuildHash: "build-current",
      promotedFindings: [finding],
    });

    expect(result.ok).toBe(false);
    expect(result.blockedFindingIds).toEqual(["stale-setup-readiness-warning"]);
    expect(result.reasons.join("\n")).toContain("no authoritative readiness evidence matches publication buildHash build-current");
  });

  it("requires analyst telemetry as primary hive-scoped evidence for readiness and routing findings", () => {
    const finding: ImprovementScanPromotedFindingEvidence = {
      findingId: "controller-global-readiness-only",
      actions: ["route_issue"],
      endpointFamily: "readiness",
      endpointEvidence: [
        {
          endpoint: "/api/readiness?hiveId=11111111-1111-4111-8111-111111111111",
          checkedAt: "2026-06-22T23:22:50.349Z",
          buildHash: "build-current",
          authoritativeFor: ["readiness"],
        },
      ],
    };

    const result = validateImprovementScanPublicationEvidence({
      publicationBuildHash: "build-current",
      promotedFindings: [finding],
    });

    expect(result.ok).toBe(false);
    expect(result.reasons.join("\n")).toContain("/api/analyst-telemetry?hiveId=...");
  });

  it("documents the required evidence fields for generated scan artifacts", () => {
    const contract = buildImprovementScanEvidenceContract({
      runtimeBuildHash: "build-current",
      checkedAt: "2026-06-22T23:22:50.349Z",
      authoritativeProbeSet: [ANALYST_TELEMETRY_EVIDENCE],
    });

    expect(contract).toMatchObject({
      purpose: "improvement_scan_publication_gate",
      runtimeBuildHash: "build-current",
      promotedFindingRequirements: {
        staleBuildPolicy: "reprobe_endpoint_family_before_publication_or_routing",
        readinessRoutingPrimarySource: "/api/analyst-telemetry?hiveId=...",
      },
    });
    expect(contract.promotedFindingRequirements.requiredFields).toEqual(expect.arrayContaining([
      "findingId",
      "actions",
      "endpointFamily",
      "endpoint",
      "checkedAt",
      "buildHash",
      "authoritativeFor",
    ]));
  });
});
