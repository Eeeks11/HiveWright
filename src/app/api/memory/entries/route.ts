import { sql } from "../../_lib/db";
import { requireApiUser } from "../../_lib/auth";
import { jsonError, jsonOk } from "../../_lib/responses";
import { canMutateHive } from "@/auth/users";
import {
  getMemoryEntryScope,
  softDeleteMemoryEntry,
} from "@/memory/governance";

type Store = "role_memory" | "hive_memory";

function isStore(value: unknown): value is Store {
  return value === "role_memory" || value === "hive_memory";
}

export async function DELETE(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  let body: { id?: unknown; store?: unknown; reason?: unknown };
  try {
    body = await request.json() as { id?: unknown; store?: unknown; reason?: unknown };
  } catch {
    return jsonError("invalid JSON", 400);
  }

  if (typeof body.id !== "string" || body.id.trim().length === 0) {
    return jsonError("id is required", 400);
  }
  if (!isStore(body.store)) {
    return jsonError("store must be role_memory or hive_memory", 400);
  }

  const scope = await getMemoryEntryScope(sql, { id: body.id, store: body.store });
  if (!scope) return jsonError("memory entry not found", 404);

  if (!authz.user.isSystemOwner) {
    const canMutate = await canMutateHive(sql, authz.user.id, scope.hiveId);
    if (!canMutate) return jsonError("Forbidden: caller cannot manage this hive", 403);
  }

  const deleted = await softDeleteMemoryEntry(sql, { id: body.id, store: body.store });
  if (!deleted) return jsonError("memory entry not found", 404);

  return jsonOk({
    id: deleted.id,
    hiveId: deleted.hiveId,
    store: deleted.store,
    status: deleted.status,
    deletedAt: deleted.deletedAt,
    reason: typeof body.reason === "string" && body.reason.trim().length > 0 ? body.reason.trim() : null,
  });
}
