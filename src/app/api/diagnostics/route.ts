import { collectHiveWrightDiagnostics } from "@/diagnostics/checks";
import {
  collectSetupRuntimeReadiness,
  listSetupRuntimeReadinessWarnings,
} from "@/setup-readiness/runtime";
import { requireApiAuth } from "../_lib/auth";
import { jsonError, jsonOk } from "../_lib/responses";

export async function GET() {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  try {
    const [diagnostics, setupRuntimeReadiness] = await Promise.all([
      collectHiveWrightDiagnostics(),
      collectSetupRuntimeReadiness(),
    ]);
    return jsonOk({
      ...diagnostics,
      setupReadiness: {
        checkedAt: setupRuntimeReadiness.checkedAt,
        warningSources: listSetupRuntimeReadinessWarnings(setupRuntimeReadiness),
      },
    });
  } catch (err) {
    console.error("[diagnostics GET] failed:", err);
    return jsonError("Failed to collect HiveWright diagnostics", 500);
  }
}
