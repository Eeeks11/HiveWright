export type ImprovementScanFindingAction = "publish" | "route_issue" | "reopen_issue" | "close_issue";

export type ImprovementScanEndpointFamily =
  | "readiness"
  | "model_routing"
  | "runtime_drift"
  | "setup_runtime"
  | "security"
  | "performance"
  | "other";

export interface ImprovementScanEndpointEvidence {
  endpoint: string;
  checkedAt: string;
  buildHash: string | null;
  authoritativeFor: ImprovementScanEndpointFamily[];
}

export interface ImprovementScanPromotedFindingEvidence {
  findingId: string;
  actions: ImprovementScanFindingAction[];
  endpointFamily: ImprovementScanEndpointFamily;
  endpointEvidence: ImprovementScanEndpointEvidence[];
}

export interface ImprovementScanPublicationGateInput {
  publicationBuildHash: string | null;
  promotedFindings: ImprovementScanPromotedFindingEvidence[];
}

export interface ImprovementScanEvidenceGateResult {
  ok: boolean;
  blockedFindingIds: string[];
  reasons: string[];
}

export interface ImprovementScanEvidenceContract {
  purpose: "improvement_scan_publication_gate";
  publicationRule: string;
  runtimeBuildHash: string | null;
  checkedAt: string;
  authoritativeProbeSet: ImprovementScanEndpointEvidence[];
  promotedFindingRequirements: {
    requiredFields: Array<keyof ImprovementScanEndpointEvidence | "findingId" | "endpointFamily" | "actions">;
    staleBuildPolicy: "reprobe_endpoint_family_before_publication_or_routing";
    readinessRoutingPrimarySource: "/api/analyst-telemetry?hiveId=...";
  };
}

const ROUTING_ACTIONS = new Set<ImprovementScanFindingAction>(["route_issue", "reopen_issue", "close_issue"]);
const READINESS_ROUTING_FAMILIES = new Set<ImprovementScanEndpointFamily>([
  "readiness",
  "model_routing",
  "runtime_drift",
]);

export function buildImprovementScanEvidenceContract(input: {
  runtimeBuildHash: string | null;
  checkedAt: string;
  authoritativeProbeSet: ImprovementScanEndpointEvidence[];
}): ImprovementScanEvidenceContract {
  return {
    purpose: "improvement_scan_publication_gate",
    publicationRule: "Before publishing, reopening/closing issues, or routing work from an improvement scan, every promoted finding must cite fresh authenticated endpoint evidence from the same runtime buildHash as publication; if the runtime buildHash changed, re-probe the affected endpoint family first.",
    runtimeBuildHash: input.runtimeBuildHash,
    checkedAt: input.checkedAt,
    authoritativeProbeSet: input.authoritativeProbeSet,
    promotedFindingRequirements: {
      requiredFields: ["findingId", "actions", "endpointFamily", "endpoint", "checkedAt", "buildHash", "authoritativeFor"],
      staleBuildPolicy: "reprobe_endpoint_family_before_publication_or_routing",
      readinessRoutingPrimarySource: "/api/analyst-telemetry?hiveId=...",
    },
  };
}

export function validateImprovementScanPublicationEvidence(
  input: ImprovementScanPublicationGateInput,
): ImprovementScanEvidenceGateResult {
  const blockedFindingIds = new Set<string>();
  const reasons: string[] = [];

  if (input.promotedFindings.length === 0) {
    block("missing_structured_evidence", "improvement scan publication requires at least one structured promoted finding evidence block");
  }

  for (const finding of input.promotedFindings) {
    const routeAffecting = finding.actions.some((action) => ROUTING_ACTIONS.has(action));
    if (!routeAffecting && finding.actions.length === 0) {
      block(finding.findingId, "promoted finding is missing a publication/routing action");
      continue;
    }

    const matchingEvidence = finding.endpointEvidence.filter((evidence) => (
      evidence.authoritativeFor.includes(finding.endpointFamily)
    ));
    if (matchingEvidence.length === 0) {
      block(finding.findingId, `missing authoritative endpoint evidence for ${finding.endpointFamily}`);
      continue;
    }

    let buildMatchedEvidence: ImprovementScanEndpointEvidence[] = [];
    if (input.publicationBuildHash) {
      buildMatchedEvidence = matchingEvidence.filter((evidence) => evidence.buildHash === input.publicationBuildHash);
      if (buildMatchedEvidence.length === 0) {
        block(finding.findingId, `no authoritative ${finding.endpointFamily} evidence matches publication buildHash ${input.publicationBuildHash}`);
        continue;
      }
    } else {
      block(finding.findingId, "publication buildHash is missing, so scan evidence cannot be proven build-matched");
      continue;
    }

    if (READINESS_ROUTING_FAMILIES.has(finding.endpointFamily)) {
      const usesAnalystTelemetry = buildMatchedEvidence.some((evidence) => isAnalystTelemetryEndpoint(evidence.endpoint));
      if (!usesAnalystTelemetry) {
        block(finding.findingId, `${finding.endpointFamily} findings must include /api/analyst-telemetry?hiveId=... as the primary hive-scoped source`);
      }
    }

    const missingTimestamp = buildMatchedEvidence.some((evidence) => !isIsoTimestamp(evidence.checkedAt));
    if (missingTimestamp) {
      block(finding.findingId, "authoritative endpoint evidence is missing an ISO checkedAt timestamp");
    }
  }

  return {
    ok: blockedFindingIds.size === 0,
    blockedFindingIds: [...blockedFindingIds],
    reasons,
  };

  function block(findingId: string, reason: string) {
    blockedFindingIds.add(findingId);
    reasons.push(`${findingId}: ${reason}`);
  }
}

function isAnalystTelemetryEndpoint(endpoint: string): boolean {
  try {
    const url = endpoint.startsWith("http") ? new URL(endpoint) : new URL(endpoint, "http://hivewright.local");
    return url.pathname === "/api/analyst-telemetry" && url.searchParams.has("hiveId");
  } catch {
    return endpoint.startsWith("/api/analyst-telemetry") && endpoint.includes("hiveId=");
  }
}

function isIsoTimestamp(value: string): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
