import { sql } from "../_lib/db";
import { jsonError, jsonOk } from "../_lib/responses";
import { requireApiUser } from "../_lib/auth";
import { canAccessHive, canMutateHive } from "@/auth/users";
import {
  ConnectorInstallError,
  createConnectorInstall,
  listConnectorInstalls,
  updateConnectorInstall,
} from "@/connectors/installs";

function connectorInstallError(err: unknown, fallback: string) {
  if (err instanceof ConnectorInstallError) {
    return jsonError(err.message, err.status);
  }
  return jsonError(fallback, 500);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const hiveId = url.searchParams.get("hiveId");
    if (!hiveId) return jsonError("hiveId is required", 400);

    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;
    if (!authz.user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
      if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
    }

    const installs = await listConnectorInstalls(sql, { hiveId });
    return jsonOk(installs);
  } catch (err) {
    console.error("[api/connector-installs GET]", err);
    return connectorInstallError(err, "Failed to fetch installs");
  }
}

export async function POST(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  try {
    const body = await request.json();
    const { hiveId, connectorSlug, displayName, fields } = body as {
      hiveId?: string;
      connectorSlug?: string;
      displayName?: string;
      fields?: Record<string, unknown>;
      grantedScopes?: unknown;
    };

    if (!hiveId || !connectorSlug || !displayName || !fields) {
      return jsonError("hiveId, connectorSlug, displayName and fields are all required", 400);
    }

    if (!authz.user.isSystemOwner) {
      const canMutate = await canMutateHive(sql, authz.user.id, hiveId);
      if (!canMutate) return jsonError("Forbidden: caller cannot mutate this hive", 403);
    }

    const install = await createConnectorInstall(sql, {
      hiveId,
      connectorSlug,
      displayName,
      fields,
      grantedScopes: body.grantedScopes,
    });

    return jsonOk({ id: install.id, connectorSlug: install.connectorSlug }, 201);
  } catch (err) {
    console.error("[api/connector-installs POST]", err);
    return connectorInstallError(err, "Failed to install connector");
  }
}

export async function PATCH(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  try {
    const body = await request.json();
    const { hiveId, installId, status, displayName, fields } = body as {
      hiveId?: string;
      installId?: string;
      status?: unknown;
      displayName?: unknown;
      fields?: Record<string, unknown>;
      grantedScopes?: unknown;
    };

    if (!hiveId || !installId) {
      return jsonError("hiveId and installId are required", 400);
    }
    if (status !== undefined && status !== "active" && status !== "disabled") {
      return jsonError("status must be active or disabled", 400);
    }
    if (displayName !== undefined && typeof displayName !== "string") {
      return jsonError("displayName must be a string", 400);
    }
    if (fields !== undefined && (typeof fields !== "object" || fields === null || Array.isArray(fields))) {
      return jsonError("fields must be an object", 400);
    }

    if (!authz.user.isSystemOwner) {
      const canMutate = await canMutateHive(sql, authz.user.id, hiveId);
      if (!canMutate) return jsonError("Forbidden: caller cannot mutate this hive", 403);
    }

    const install = await updateConnectorInstall(sql, {
      hiveId,
      installId,
      status: status as "active" | "disabled" | undefined,
      displayName: displayName as string | undefined,
      fields,
      grantedScopes: body.grantedScopes,
    });

    return jsonOk(install);
  } catch (err) {
    console.error("[api/connector-installs PATCH]", err);
    return connectorInstallError(err, "Failed to update install");
  }
}
