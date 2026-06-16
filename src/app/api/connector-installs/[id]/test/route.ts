import { jsonError, jsonOk } from "../../../_lib/responses";
import { sql } from "../../../_lib/db";
import { requireApiUser } from "../../../_lib/auth";
import { getConnectorDefinition } from "@/connectors/registry";
import { invokeConnectorReadOnlyOrSystem } from "@/connectors/runtime";
import { setConnectorInstallStatus } from "@/connectors/installs";
import { requireResourceOwnedByHive, requireStrictHiveTarget } from "@/app/api/_lib/hive-target";

/**
 * POST /api/connector-installs/:id/test
 * Body is intentionally ignored for operation selection. This endpoint only
 * runs the connector's safe system test operation.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  try {
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as {
      hiveId?: unknown;
      operation?: string;
      args?: Record<string, unknown>;
    };
    const target = await requireStrictHiveTarget(
      sql,
      authz.user,
      { kind: "body", body },
      { mode: "mutate" },
    );
    if (!target.ok) return target.response;

    const [install] = await sql`
      SELECT connector_slug, hive_id AS "hiveId" FROM connector_installs WHERE id = ${id}
    `;
    const ownership = requireResourceOwnedByHive(install?.hiveId as string | undefined, target.hiveId, { resourceName: "Install" });
    if (!ownership.ok) return ownership.response;

    const def = getConnectorDefinition(install.connector_slug as string);
    if (!def) return jsonError(`unknown connector ${install.connector_slug}`, 400);

    void body;

    const testOperation = def.operations.find((operation) =>
      ["test_connection", "self_test"].includes(operation.slug) &&
      operation.governance.effectType === "system" &&
      operation.governance.defaultDecision === "allow" &&
      operation.governance.riskTier === "low" &&
      operation.governance.externalSideEffect !== true
    );
    if (!testOperation) return jsonError("connector has no safe test operation", 400);

    const result = await invokeConnectorReadOnlyOrSystem(sql, {
      installId: id,
      operation: testOperation.slug,
      args: {},
      actor: "owner-test",
    });

    await setConnectorInstallStatus(sql, {
      installId: id,
      hiveId: install.hiveId as string,
      status: result.success ? "active" : "broken",
      tested: true,
      lastError: result.success ? null : result.error ?? "health test failed",
    });

    return jsonOk(result);
  } catch (err) {
    console.error("[api/connector-installs/:id/test]", err);
    return jsonError("Test failed", 500);
  }
}
