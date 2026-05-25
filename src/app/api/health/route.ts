import { getHiveWrightHealthSnapshot } from "@/diagnostics/checks";
import { jsonOk } from "../_lib/responses";

export async function GET() {
  return jsonOk(getHiveWrightHealthSnapshot());
}
