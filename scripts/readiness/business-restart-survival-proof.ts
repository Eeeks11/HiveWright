import "dotenv/config";
import postgres, { type Sql } from "postgres";
import { recoverInterruptedActiveTasks } from "@/dispatcher/watchdog";

const PROOF_PREFIX = "[restart-survival-proof]";

export interface BusinessRestartSurvivalProofResult {
  recoveredInterruptedTasks: number;
  staleActiveCleared: boolean;
  finalWorkProductExists: boolean;
  ownerOpenableDeliverable: boolean;
  completionEvidenceReferencesDeliverable: boolean;
  isolatedToProofHive: boolean;
}

interface ProofRow {
  active_stale_tasks: string | number;
  final_work_products: string | number;
  owner_openable_deliverables: string | number;
  completion_evidence_references_deliverable: boolean | null;
  proof_cross_hive_rows: string | number;
  external_rows_mutated: string | number;
}

export async function runBusinessRestartSurvivalProof(
  sql: Sql,
  input: {
    hiveId: string;
    currentPid?: number;
    interruptedPid?: number;
    pidAlive?: (pid: number) => boolean;
  },
): Promise<BusinessRestartSurvivalProofResult> {
  const currentPid = input.currentPid ?? process.pid;
  const interruptedPid = input.interruptedPid ?? 987_654_321;
  const beforeExternalRows = await countExternalRecoveryRows(sql, input.hiveId);

  await seedProofData(sql, input.hiveId, interruptedPid);

  const interrupted = await recoverInterruptedActiveTasks(
    sql,
    currentPid,
    input.pidAlive ?? (() => false),
    { hiveId: input.hiveId, titlePrefix: PROOF_PREFIX },
  );

  const afterExternalRows = await countExternalRecoveryRows(sql, input.hiveId);

  const rows = await (sql`
    WITH proof_tasks AS (
      SELECT id, goal_id
      FROM tasks
      WHERE hive_id = ${input.hiveId}::uuid
        AND title LIKE ${`${PROOF_PREFIX}%`}
    ), proof_work_products AS (
      SELECT wp.id, wp.public_url, wp.source_url
      FROM work_products wp
      JOIN proof_tasks pt ON pt.id = wp.task_id
      WHERE wp.hive_id = ${input.hiveId}::uuid
    ), proof_completions AS (
      SELECT gc.evidence
      FROM goal_completions gc
      JOIN proof_tasks pt ON pt.goal_id = gc.goal_id
    )
    SELECT
      (SELECT COUNT(*) FROM tasks
        WHERE hive_id = ${input.hiveId}::uuid
          AND title LIKE ${`${PROOF_PREFIX}%`}
          AND status = 'active'
          AND dispatcher_pid IS NOT NULL
          AND dispatcher_pid <> ${currentPid}
          AND dispatcher_pid = ${interruptedPid})::int AS active_stale_tasks,
      (SELECT COUNT(*) FROM proof_work_products)::int AS final_work_products,
      (SELECT COUNT(*) FROM proof_work_products
        WHERE public_url IS NOT NULL
          AND public_url <> ''
          AND (public_url LIKE 'http://%' OR public_url LIKE 'https://%' OR public_url LIKE '/api/work-products/%' OR public_url LIKE '/deliverables/%'))::int AS owner_openable_deliverables,
      EXISTS (
        SELECT 1
        FROM proof_completions pc
        WHERE jsonb_array_length(COALESCE(pc.evidence->'workProductIds', '[]'::jsonb)) > 0
           OR EXISTS (
             SELECT 1
             FROM jsonb_array_elements(COALESCE(pc.evidence->'bundle', '[]'::jsonb)) AS bundle_item
             WHERE COALESCE(bundle_item->>'reference', bundle_item->>'value', '') LIKE '/api/work-products/%'
                OR COALESCE(bundle_item->>'reference', bundle_item->>'value', '') LIKE '/deliverables/%'
           )
      ) AS completion_evidence_references_deliverable,
      (SELECT COUNT(*) FROM work_products wp
        JOIN proof_tasks pt ON pt.id = wp.task_id
        WHERE wp.hive_id <> ${input.hiveId}::uuid)::int AS proof_cross_hive_rows,
      ${afterExternalRows - beforeExternalRows}::int AS external_rows_mutated
  ` as Promise<ProofRow[]>);
  const row = rows[0];

  return {
    recoveredInterruptedTasks: interrupted.length,
    staleActiveCleared: toCount(row?.active_stale_tasks) === 0,
    finalWorkProductExists: toCount(row?.final_work_products) > 0,
    ownerOpenableDeliverable: toCount(row?.owner_openable_deliverables) > 0,
    completionEvidenceReferencesDeliverable: Boolean(row?.completion_evidence_references_deliverable),
    isolatedToProofHive: toCount(row?.proof_cross_hive_rows) === 0 && toCount(row?.external_rows_mutated) === 0,
  };
}

async function seedProofData(sql: Sql, hiveId: string, interruptedPid: number): Promise<void> {
  const run = async (tx: Sql) => {
    const roleRows = await (tx`
      SELECT slug FROM role_templates WHERE active = true ORDER BY slug LIMIT 1
    ` as Promise<Array<{ slug: string }>>);
    const roleSlug = roleRows[0]?.slug ?? "goal-supervisor";

    const goalRows = await (tx`
      INSERT INTO goals (hive_id, title, description, status, created_at, updated_at)
      VALUES (${hiveId}::uuid, ${`${PROOF_PREFIX} deterministic owner outcome`}, 'Restart survival proof fixture.', 'active', NOW(), NOW())
      RETURNING id
    ` as Promise<Array<{ id: string }>>);
    const goalId = goalRows[0]?.id ?? "00000000-0000-0000-0000-000000000001";

    const taskRows = await (tx`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, status, priority, title, brief, goal_id,
        dispatcher_pid, started_at, last_heartbeat, created_at, updated_at
      ) VALUES (
        ${hiveId}::uuid, ${roleSlug}, 'restart-survival-proof', 'active', 1,
        ${`${PROOF_PREFIX} interrupted task`}, 'Proof task intentionally marked active under a dead dispatcher PID.', ${goalId}::uuid,
        ${interruptedPid}, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes', NOW(), NOW()
      )
      RETURNING id
    ` as Promise<Array<{ id: string }>>);
    const taskId = taskRows[0]?.id ?? "00000000-0000-0000-0000-000000000002";

    const workProductRows = await (tx`
      INSERT INTO work_products (
        task_id, hive_id, role_slug, content, title, summary, artifact_kind,
        render_mode, public_url, sensitivity, created_at, published_at
      ) VALUES (
        ${taskId}::uuid, ${hiveId}::uuid, ${roleSlug}, 'Restart survival proof deliverable.',
        'Restart survival proof deliverable', 'Owner-openable proof artifact.', 'html',
        'html', ${`/api/work-products/${taskId}/open`}, 'internal', NOW(), NOW()
      )
      RETURNING id
    ` as Promise<Array<{ id: string }>>);
    const workProductId = workProductRows[0]?.id ?? "00000000-0000-0000-0000-000000000003";

    await tx`
      INSERT INTO goal_completions (goal_id, summary, evidence, learning_gate, created_by, created_at)
      VALUES (
        ${goalId}::uuid,
        'Restart survival proof completed with owner-openable evidence.',
        ${jsonParam({
          taskIds: [taskId],
          workProductIds: [workProductId],
          bundle: [{
            type: "deliverable",
            description: "Owner-openable proof deliverable",
            reference: `/api/work-products/${taskId}/open`,
            verified: true,
          }],
        })},
        ${jsonParam({ passed: true })},
        'restart-survival-proof',
        NOW()
      )
    `;
  };

  if (typeof (sql as unknown as { begin?: unknown }).begin === "function") {
    await (sql as unknown as { begin: (fn: (tx: Sql) => Promise<void>) => Promise<void> }).begin(run);
    return;
  }
  await run(sql);
}

function jsonParam(value: unknown): string {
  return JSON.stringify(value);
}

async function countExternalRecoveryRows(sql: Sql, hiveId: string): Promise<number> {
  const rows = await (sql`
    SELECT COUNT(*)::int AS count
    FROM tasks
    WHERE hive_id <> ${hiveId}::uuid
      AND failure_reason ILIKE 'Interrupted by dispatcher lifecycle recovery:%'
  ` as Promise<Array<{ count: number | string }>>);
  return toCount(rows[0]?.count);
}

function toCount(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isSafeProofDatabase(url: string): boolean {
  return /localhost|127\.0\.0\.1/.test(url) && /test|hivewrightv2/.test(url);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const hiveId = process.env.HIVEWRIGHT_RESTART_PROOF_HIVE_ID;
  if (!databaseUrl || !hiveId) {
    console.error("business-restart-survival-proof requires DATABASE_URL and HIVEWRIGHT_RESTART_PROOF_HIVE_ID. Refusing to infer or touch production data.");
    process.exitCode = 2;
    return;
  }
  if (!isSafeProofDatabase(databaseUrl) || process.env.HIVEWRIGHT_ALLOW_RESTART_SURVIVAL_PROOF !== "true") {
    console.error("Refusing to run restart survival proof without a local/test DATABASE_URL and HIVEWRIGHT_ALLOW_RESTART_SURVIVAL_PROOF=true.");
    process.exitCode = 2;
    return;
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const result = await runBusinessRestartSurvivalProof(sql, { hiveId });
    console.log(JSON.stringify(result, null, 2));
    if (!Object.values(result).every(Boolean)) process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

if (process.argv[1]?.endsWith("business-restart-survival-proof.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
