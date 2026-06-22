import { requireApiAuth } from "../_lib/auth";
import { sql } from "../_lib/db";
import { jsonError, jsonOk, parseSearchParams } from "../_lib/responses";
import {
  collectSetupRuntimeReadiness,
  listActiveSetupRuntimeSources,
  listSetupRuntimeReadinessWarnings,
} from "@/setup-readiness/runtime";

const HIVE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request?: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  const hiveId = request ? parseSearchParams(request.url).get("hiveId") : null;
  if (hiveId && !HIVE_ID_RE.test(hiveId)) return jsonError("hiveId must be a valid UUID", 400);

  const snapshot = await collectSetupRuntimeReadiness();
  if (!hiveId) return jsonOk(snapshot);

  const activeSources = await listActiveSetupRuntimeSources(sql, { hiveId });

  return jsonOk({
    ...snapshot,
    warningSources: listSetupRuntimeReadinessWarnings(snapshot, { activeSources }),
  });
}
