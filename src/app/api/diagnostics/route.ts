import { collectHiveWrightDiagnostics } from "@/diagnostics/checks";
import { requireApiAuth } from "../_lib/auth";
import { jsonError, jsonOk } from "../_lib/responses";

export async function GET() {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  try {
    return jsonOk(await collectHiveWrightDiagnostics());
  } catch (err) {
    console.error("[diagnostics GET] failed:", err);
    return jsonError("Failed to collect HiveWright diagnostics", 500);
  }
}
