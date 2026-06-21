import { collectHiveWrightDiagnostics } from "@/diagnostics/checks";
import {
  collectSetupRuntimeReadiness,
  listActiveSetupRuntimeSources,
  listSetupRuntimeReadinessWarnings,
} from "@/setup-readiness/runtime";
import { requireApiAuth } from "../_lib/auth";
import { sql } from "../_lib/db";
import { jsonError, jsonOk } from "../_lib/responses";

export async function GET() {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  try {
    const [diagnostics, setupRuntimeReadiness, activeSetupRuntimeSources] = await Promise.all([
      collectHiveWrightDiagnostics(),
      collectSetupRuntimeReadiness(),
      listActiveSetupRuntimeSources(sql),
    ]);
    return jsonOk({
      ...diagnostics,
      setupReadiness: {
        checkedAt: setupRuntimeReadiness.checkedAt,
        warningSources: listSetupRuntimeReadinessWarnings(setupRuntimeReadiness, {
          activeSources: activeSetupRuntimeSources,
        }),
      },
    });
  } catch (err) {
    console.error("[diagnostics GET] failed:", err);
    return jsonError("Failed to collect HiveWright diagnostics", 500);
  }
}
