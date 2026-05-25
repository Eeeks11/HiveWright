import { buildDiagnosticBundle } from "@/diagnostics/bundle";
import { requireApiAuth } from "../../_lib/auth";
import { jsonError, jsonOk } from "../../_lib/responses";

export async function GET() {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  try {
    return jsonOk(await buildDiagnosticBundle());
  } catch (err) {
    console.error("[diagnostics bundle GET] failed:", err);
    return jsonError("Failed to build diagnostic bundle", 500);
  }
}
