import { sql } from "../../../_lib/db";
import { jsonOk, jsonError } from "../../../_lib/responses";
import { requireApiUser } from "../../../_lib/auth";
import { requireHiveTargetMatchesPath, requireStrictHiveTarget } from "../../../_lib/hive-target";
import { type TargetStatus, isValidStatus } from "./_status";

interface TargetInput {
  title?: unknown;
  target_value?: unknown;
  deadline?: unknown;
  notes?: unknown;
  sort_order?: unknown;
  status?: unknown;
}

function rowToApi(row: Record<string, unknown>) {
  return {
    id: row.id,
    hiveId: row.hive_id,
    title: row.title,
    targetValue: row.target_value,
    deadline: row.deadline,
    notes: row.notes,
    sortOrder: row.sort_order,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { id } = await params;
  const requestedHive = requireHiveTargetMatchesPath({ kind: "query", request: _request }, id);
  if (requestedHive.ok === false) return requestedHive.response;

  const target = await requireStrictHiveTarget(
    sql,
    authz.user,
    { kind: "path", params: { id }, key: "id" },
    { label: "id" },
  );
  if (target.ok === false) return target.response;

  const rows = await sql`
    SELECT * FROM hive_targets
    WHERE hive_id = ${id}
    ORDER BY sort_order ASC, created_at ASC
  `;
  return jsonOk(rows.map(rowToApi));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Audit d20f7b46 Sprint 2: hive-scoped mutation must require hive access.
  // Resolve the caller via requireApiUser; non-owner callers must pass
  // canAccessHive on the target hive. System owners bypass membership.
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;

  let body: TargetInput;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON", 400);
  }

  const requestedHive = requireHiveTargetMatchesPath({ kind: "body", body: body as Record<string, unknown> }, id);
  if (requestedHive.ok === false) return requestedHive.response;

  const target = await requireStrictHiveTarget(
    sql,
    user,
    { kind: "path", params: { id }, key: "id" },
    { mode: "mutate", label: "id" },
  );
  if (target.ok === false) return target.response;

  if (typeof body.title !== "string" || body.title.trim() === "") {
    return jsonError("title is required", 400);
  }

  if (body.status !== undefined && !isValidStatus(body.status)) {
    return jsonError("invalid status (must be open | achieved | abandoned)", 400);
  }
  const status: TargetStatus = isValidStatus(body.status) ? body.status : "open";

  let sortOrder: number;
  if (typeof body.sort_order === "number") {
    sortOrder = body.sort_order;
  } else {
    const [max] = await sql<{ m: number | null }[]>`
      SELECT MAX(sort_order)::int AS m FROM hive_targets WHERE hive_id = ${id}
    `;
    sortOrder = (max?.m ?? -1) + 1;
  }

  const targetValue = typeof body.target_value === "string" ? body.target_value : null;
  const deadline = typeof body.deadline === "string" && body.deadline.trim() !== ""
    ? body.deadline : null;
  const notes = typeof body.notes === "string" ? body.notes : null;

  const [row] = await sql`
    INSERT INTO hive_targets (hive_id, title, target_value, deadline, notes, sort_order, status)
    VALUES (${id}, ${body.title.trim()}, ${targetValue}, ${deadline}, ${notes}, ${sortOrder}, ${status})
    RETURNING *
  `;

  return jsonOk(rowToApi(row), 201);
}
