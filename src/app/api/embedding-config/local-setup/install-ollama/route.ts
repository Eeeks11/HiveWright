import { requireSystemOwner } from "../../../_lib/auth";
import { jsonError, jsonOk } from "../../../_lib/responses";
import { installOllamaWithConfirmation, sanitizeError } from "@/memory/local-embedding-setup";

export async function POST(request: Request) {
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;

  try {
    const body = await request.json().catch(() => ({})) as { confirmed?: boolean };
    const result = await installOllamaWithConfirmation({ confirmed: body.confirmed });
    return jsonOk({ result });
  } catch (err) {
    return jsonError(sanitizeError(err), 400);
  }
}
