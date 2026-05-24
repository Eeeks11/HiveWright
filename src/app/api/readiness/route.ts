import { collectHiveWrightDiagnostics } from "@/diagnostics/checks";
import { jsonError, jsonOk } from "../_lib/responses";

export async function GET() {
  try {
    const diagnostics = await collectHiveWrightDiagnostics();
    const body = {
      status: diagnostics.summary.ready ? "ready" : "not_ready",
      ready: diagnostics.summary.ready,
      checkedAt: diagnostics.checkedAt,
      severity: diagnostics.summary.severity,
      counts: diagnostics.summary.counts,
      ownerActionRequired: diagnostics.summary.ownerActionRequired,
    };
    return jsonOk(body, diagnostics.summary.ready ? 200 : 503);
  } catch (err) {
    console.error("[readiness GET] failed:", err);
    return jsonError("HiveWright readiness could not be evaluated", 503);
  }
}
