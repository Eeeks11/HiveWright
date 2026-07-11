import { sql } from "../../_lib/db";
import { jsonOk } from "../../_lib/responses";
import { ownerSetupRequired } from "@/auth/owner-bootstrap";

export async function GET() {
  return jsonOk({ needsSetup: await ownerSetupRequired(sql) });
}
