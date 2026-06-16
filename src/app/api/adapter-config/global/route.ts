import { sql } from "../../_lib/db";
import { jsonOk, jsonError } from "../../_lib/responses";
import { requireApiUser } from "../../_lib/auth";

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  try {
    const adapterType = new URL(request.url).searchParams.get("adapterType");
    const rows = adapterType
      ? await sql`SELECT * FROM adapter_config WHERE hive_id IS NULL AND adapter_type = ${adapterType} ORDER BY adapter_type`
      : await sql`SELECT * FROM adapter_config WHERE hive_id IS NULL ORDER BY adapter_type`;
    const data = rows.map(r => ({
      id: r.id,
      hiveId: r.hive_id ?? null,
      adapterType: r.adapter_type,
      config: r.config,
      createdAt: r.created_at,
    }));
    return jsonOk(data);
  } catch {
    return jsonError("Failed to fetch global adapter config", 500);
  }
}
