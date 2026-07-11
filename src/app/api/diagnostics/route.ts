import { collectHiveWrightDiagnostics } from "@/diagnostics/checks";
import {
  collectSetupRuntimeReadiness,
  listActiveSetupRuntimeSources,
  listSetupRuntimeReadinessWarnings,
} from "@/setup-readiness/runtime";
import { requireApiAuth } from "../_lib/auth";
import { sql } from "../_lib/db";
import { jsonError, jsonOk, parseSearchParams } from "../_lib/responses";

const HIVE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  const hiveId = parseSearchParams(request.url).get("hiveId");
  if (hiveId && !HIVE_ID_RE.test(hiveId)) return jsonError("hiveId must be a valid UUID", 400);

  try {
    const activeSetupRuntimeSourcesPromise = hiveId
      ? listActiveSetupRuntimeSources(sql, { hiveId })
      : Promise.resolve([]);
    const [diagnostics, setupRuntimeReadiness, activeSetupRuntimeSources] = await Promise.all([
      collectHiveWrightDiagnostics(),
      collectSetupRuntimeReadiness(),
      activeSetupRuntimeSourcesPromise,
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
