import { sql } from "../../_lib/db";
import { jsonError, jsonOk } from "../../_lib/responses";
import { requireApiUser } from "../../_lib/auth";
import { requireResourceOwnedByHive, requireStrictHiveTarget } from "@/app/api/_lib/hive-target";
import {
  AGENT_AUDIT_EVENTS,
  recordAgentAuditEventBestEffort,
} from "@/audit/agent-events";

const ALLOWED_STATUSES = new Set(["active", "disabled"]);

type InstallRow = {
  id: string;
  hiveId: string;
  connectorSlug: string;
  displayName: string;
  status: string;
  updatedAt: Date;
};

function mapInstall(row: InstallRow) {
  return {
    id: row.id,
    hiveId: row.hiveId,
    connectorSlug: row.connectorSlug,
    displayName: row.displayName,
    status: row.status,
    updatedAt: row.updatedAt,
  };
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  try {
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as { hiveId?: unknown; status?: unknown };
    if (typeof body.status !== "string" || !ALLOWED_STATUSES.has(body.status)) {
      return jsonError("status must be active or disabled", 400);
    }
    const target = await requireStrictHiveTarget(
      sql,
      authz.user,
      { kind: "body", body },
      { mode: "mutate" },
    );
    if (!target.ok) return target.response;

    const [install] = await sql<{ hiveId: string }[]>`
      SELECT hive_id AS "hiveId" FROM connector_installs WHERE id = ${id}
    `;
    const ownership = requireResourceOwnedByHive(install?.hiveId, target.hiveId, { resourceName: "Install" });
    if (!ownership.ok) return ownership.response;

    const [row] = await sql<InstallRow[]>`
      UPDATE connector_installs
      SET status = ${body.status}, updated_at = NOW()
      WHERE id = ${id} AND hive_id = ${target.hiveId}::uuid
      RETURNING
        id,
        hive_id AS "hiveId",
        connector_slug AS "connectorSlug",
        display_name AS "displayName",
        status,
        updated_at AS "updatedAt"
    `;
    if (body.status === "disabled") {
      await recordAgentAuditEventBestEffort(sql, {
        actor: { type: "owner", id: authz.user.id, label: authz.user.email },
        eventType: AGENT_AUDIT_EVENTS.connectorRevokedByOwner,
        hiveId: row.hiveId,
        targetType: "connector_install",
        targetId: row.id,
        outcome: "success",
        metadata: {
          connectorSlug: row.connectorSlug,
          displayName: row.displayName,
          revocationAction: "disable",
        },
      });
    }
    return jsonOk(mapInstall(row));
  } catch (err) {
    console.error("[api/connector-installs PATCH]", err);
    return jsonError("Failed to update install", 500);
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  try {
    const { id } = await ctx.params;
    const target = await requireStrictHiveTarget(
      sql,
      authz.user,
      { kind: "query", request },
      { mode: "mutate" },
    );
    if (!target.ok) return target.response;

    const [install] = await sql<{
      hiveId: string;
      connectorSlug: string;
      displayName: string;
    }[]>`
      SELECT
        hive_id AS "hiveId",
        connector_slug AS "connectorSlug",
        display_name AS "displayName"
      FROM connector_installs
      WHERE id = ${id}
    `;
    const ownership = requireResourceOwnedByHive(install?.hiveId, target.hiveId, { resourceName: "Install" });
    if (!ownership.ok) return ownership.response;

    // Cascade-deletes connector_events via FK; credential row survives so
    // the audit of "who had access and when" is preserved — the owner can
    // rotate/delete it explicitly from the credentials settings page.
    await sql`DELETE FROM connector_installs WHERE id = ${id} AND hive_id = ${target.hiveId}::uuid`;
    await recordAgentAuditEventBestEffort(sql, {
      actor: { type: "owner", id: authz.user.id, label: authz.user.email },
      eventType: AGENT_AUDIT_EVENTS.connectorRevokedByOwner,
      hiveId: install.hiveId,
      targetType: "connector_install",
      targetId: id,
      outcome: "success",
      metadata: {
        connectorSlug: install.connectorSlug,
        displayName: install.displayName,
        revocationAction: "delete",
      },
    });
    return jsonOk({ deleted: true });
  } catch (err) {
    console.error("[api/connector-installs DELETE]", err);
    return jsonError("Failed to delete install", 500);
  }
}
