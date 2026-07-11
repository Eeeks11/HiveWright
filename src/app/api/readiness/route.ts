import { collectHiveWrightDiagnostics } from "@/diagnostics/checks";
import { jsonError, jsonOk } from "../_lib/responses";

// hive-access-not-required: readiness is controller-global; hiveId is read only to disclose that it is not applied.
export async function GET(request: Request) {
  try {
    const requestedHiveId = new URL(request.url).searchParams.get("hiveId");
    const diagnostics = await collectHiveWrightDiagnostics();
    const body = {
      status: diagnostics.summary.ready ? "ready" : "not_ready",
      ready: diagnostics.summary.ready,
      checkedAt: diagnostics.checkedAt,
      severity: diagnostics.summary.severity,
      counts: diagnostics.summary.counts,
      ownerActionRequired: diagnostics.summary.ownerActionRequired,
      scope: diagnostics.scope,
      requestedHiveId,
      hiveScopedReadinessEndpoint: diagnostics.scope.hiveScopedReadinessEndpoint,
      scopeNotice: requestedHiveId
        ? `/api/readiness is ${diagnostics.scope.label}; hiveId=${requestedHiveId} was not used to calculate this response. Use ${diagnostics.scope.hiveScopedReadinessEndpoint} for hive-scoped readiness evidence.`
        : diagnostics.scope.summary,
    };
    return jsonOk(body, diagnostics.summary.ready ? 200 : 503);
  } catch (err) {
    console.error("[readiness GET] failed:", err);
    return jsonError("HiveWright readiness could not be evaluated", 503);
  }
}
