import { sanitizeAuditString } from "@/actions/redaction";
import { requireStrictHiveTarget } from "@/app/api/_lib/hive-target";
import { ConnectorSyncError, syncConnectorInstall } from "@/connectors/sync";
import { requireApiUser } from "../../../_lib/auth";
import { sql } from "../../../_lib/db";
import { jsonError, jsonOk } from "../../../_lib/responses";

function syncError(err: unknown) {
  const message = err instanceof Error ? sanitizeAuditString(err.message) : "Sync failed";
  const status = err instanceof ConnectorSyncError ? err.status : 500;
  return jsonError(message, status);
}

function parseStreams(value: unknown): string[] | null {
  if (value === undefined) return ["default"];
  if (!Array.isArray(value) || value.length === 0) return null;
  const streams = value.filter((stream): stream is string => typeof stream === "string" && stream.trim().length > 0)
    .map((stream) => stream.trim());
  if (streams.length !== value.length) return null;
  return Array.from(new Set(streams));
}

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
      streams?: unknown;
    };
    const target = await requireStrictHiveTarget(
      sql,
      authz.user,
      { kind: "body", body },
      { mode: "mutate" },
    );
    if (!target.ok) return target.response;
    const streams = parseStreams(body.streams);
    if (!streams) {
      return jsonError("streams must be a non-empty array of strings", 400);
    }

    const result = await syncConnectorInstall(sql, {
      hiveId: target.hiveId,
      installId: id,
      streams,
      actor: authz.user.id,
    });
    return jsonOk(result);
  } catch (err) {
    if (!(err instanceof ConnectorSyncError)) {
      console.error("[api/connector-installs/:id/sync]", err);
    }
    return syncError(err);
  }
}
