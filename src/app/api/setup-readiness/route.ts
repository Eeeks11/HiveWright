import { requireApiAuth } from "../_lib/auth";
import { jsonOk } from "../_lib/responses";
import { collectSetupRuntimeReadiness } from "@/setup-readiness/runtime";

export async function GET() {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  return jsonOk(await collectSetupRuntimeReadiness());
}
