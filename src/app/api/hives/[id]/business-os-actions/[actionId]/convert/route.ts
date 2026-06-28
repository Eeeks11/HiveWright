import { canMutateHive } from "@/auth/users";
import {
  convertBusinessActionToAgentTask,
  convertBusinessActionToSchedule,
  convertBusinessActionToSopDraft,
} from "@/operating-loops/business-action-runtime";
import { requireApiUser } from "../../../../../_lib/auth";
import { sql } from "../../../../../_lib/db";
import { jsonError, jsonOk } from "../../../../../_lib/responses";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ConversionKind = "create_agent_task" | "create_schedule" | "create_sop_draft";

function isConversionKind(value: unknown): value is ConversionKind {
  return value === "create_agent_task" || value === "create_schedule" || value === "create_sop_draft";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; actionId: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { id, actionId } = await params;
  if (!UUID_RE.test(id)) return jsonError("id must be a valid UUID", 400);
  if (!UUID_RE.test(actionId)) return jsonError("actionId must be a valid UUID", 400);

  if (!authz.user.isSystemOwner) {
    const canMutate = await canMutateHive(sql, authz.user.id, id);
    if (!canMutate) return jsonError("Forbidden: hive mutation access required", 403);
  }

  const [actionScope] = await sql<{ id: string }[]>`
    SELECT id
    FROM business_actions
    WHERE id = ${actionId}::uuid
      AND hive_id = ${id}::uuid
  `;
  if (!actionScope) return jsonError("Business OS action not found for hive", 404);

  const body = await request.json().catch(() => ({}));
  const conversion = body.conversion;
  if (!isConversionKind(conversion)) {
    return jsonError("conversion must be one of: create_agent_task, create_schedule, create_sop_draft", 400);
  }

  try {
    if (conversion === "create_agent_task") {
      const assignedTo = typeof body.assignedTo === "string" && body.assignedTo ? body.assignedTo : "hivewright-developer";
      const result = await convertBusinessActionToAgentTask(sql, {
        actionId,
        assignedTo,
        createdBy: authz.user.id,
        priority: typeof body.priority === "number" ? body.priority : undefined,
      });
      return jsonOk({ conversion, task: result.task, action: result.action }, 201);
    }

    if (conversion === "create_schedule") {
      const assignedTo = typeof body.assignedTo === "string" && body.assignedTo ? body.assignedTo : "hivewright-developer";
      if (typeof body.cronExpression !== "string" || !body.cronExpression.trim()) {
        return jsonError("cronExpression is required for create_schedule", 400);
      }
      const result = await convertBusinessActionToSchedule(sql, {
        actionId,
        assignedTo,
        cronExpression: body.cronExpression,
        createdBy: authz.user.id,
        priority: typeof body.priority === "number" ? body.priority : undefined,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      });
      return jsonOk({ conversion, schedule: result.schedule, action: result.action }, 201);
    }

    const roleSlug = typeof body.roleSlug === "string" && body.roleSlug ? body.roleSlug : "hivewright-developer";
    const content = typeof body.content === "string" && body.content.trim()
      ? body.content
      : `# SOP draft\n\nBusiness OS action ${actionId} needs an owner-reviewable SOP draft.`;
    const result = await convertBusinessActionToSopDraft(sql, {
      actionId,
      roleSlug,
      createdBy: authz.user.id,
      content,
      title: typeof body.title === "string" ? body.title : undefined,
    });
    return jsonOk({ conversion, task: result.task, workProduct: result.workProduct, action: result.action }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to convert Business OS action";
    return jsonError(message, 400);
  }
}
