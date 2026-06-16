import { sql } from "../../../_lib/db";
import { jsonError, jsonOk } from "../../../_lib/responses";
import { requireApiUser } from "../../../_lib/auth";
import { requireStrictHiveTarget } from "@/app/api/_lib/hive-target";
import { readTaskSecurityPreflight } from "@/security/preflight-report";

const LOCAL_PREFLIGHT_ROUTE = {
  mode: "local-precommit-compatible",
  reportSource: "local security scan report",
  reportCommand: "npm run security:scan",
  githubMcp: {
    status: "not_evidenced",
    detail: "No GitHub MCP integration is wired into this route; it reads local baseline-security-scan.json output.",
  },
  ghasPromptCodePathScanning: {
    status: "not_supported",
    detail: "This route does not claim GitHub Advanced Security prompt scanning or runtime code-path scanning support.",
  },
} as const;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;
    const { user } = authz;
    const { id } = await params;
    const target = await requireStrictHiveTarget(sql, user, { kind: "query", request });
    if (!target.ok) return target.response;

    const [task] = await sql<{ id: string; hive_id: string }[]>`
      SELECT id, hive_id
      FROM tasks
      WHERE id = ${id} AND hive_id = ${target.hiveId}::uuid
    `;
    if (!task) {
      return jsonError("Task not found", 404);
    }

    const preflight = readTaskSecurityPreflight();

    return jsonOk({
      taskId: id,
      reportPath: preflight.reportPath,
      generatedAt: preflight.generatedAt,
      preflightRoute: LOCAL_PREFLIGHT_ROUTE,
      secretScan: preflight.secretScan,
      dependencyScan: preflight.dependencyScan,
    });
  } catch {
    return jsonError("Failed to fetch security preflight", 500);
  }
}
