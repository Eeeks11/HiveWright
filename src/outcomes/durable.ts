import type { Sql, TransactionSql } from "postgres";

type QuerySql = Sql | TransactionSql;

type EvidenceRecord = {
  taskIds?: string[];
  workProductIds?: string[];
  bundle?: unknown[];
};

type PrimaryWorkProduct = {
  id: string;
  open_url: string | null;
  title: string | null;
  render_mode: string | null;
};

type GoalOutcomeContext = {
  kind: string | null;
  title: string;
};

export interface UpsertOwnerOutcomeInput {
  hiveId: string;
  goalId: string;
  goalCompletionId: string;
  completionSummary: string;
  evidence: EvidenceRecord;
}

function compactText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}...` : text;
}

function workProductIds(evidence: EvidenceRecord): string[] {
  return (evidence.workProductIds ?? [])
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter(Boolean);
}

function kindLabel(kind: string | null): string {
  switch (kind) {
    case "business":
      return "Business";
    case "personal_project":
    case "project":
      return "Project";
    case "personal_assistant":
      return "Personal assistant";
    case "research":
      return "Research";
    case "creative":
      return "Creative";
    default:
      return "Hive";
  }
}

function impactStatement(kind: string | null, goalTitle: string): string {
  const label = kindLabel(kind);
  switch (label) {
    case "Business":
      return `Business hive impact: completed work for "${goalTitle}" is now an owner-visible handoff with review state.`;
    case "Project":
      return `Project hive impact: "${goalTitle}" has a shippable result ready for owner review.`;
    case "Personal assistant":
      return `Personal assistant impact: "${goalTitle}" is packaged so the owner can act or ask for revision.`;
    case "Research":
      return `Research hive impact: findings for "${goalTitle}" are ready for owner review and next-step selection.`;
    case "Creative":
      return `Creative hive impact: the finished asset for "${goalTitle}" is ready for owner inspection.`;
    default:
      return `Hive impact: "${goalTitle}" is complete and ready for owner review.`;
  }
}

function whyItMatters(goalTitle: string): string {
  return `This creates a durable owner-visible handoff for "${goalTitle}" so final outcomes are reviewed separately from task artifacts and audit logs.`;
}

function recommendedNextAction(primary: PrimaryWorkProduct | null): string {
  if (primary?.open_url) return "Review the primary work product, then accept it or request a bounded revision.";
  return "Review the goal handoff and linked evidence, then accept it or request a bounded revision.";
}

async function selectPrimaryWorkProduct(
  sql: QuerySql,
  input: Pick<UpsertOwnerOutcomeInput, "hiveId" | "goalId" | "evidence">,
): Promise<PrimaryWorkProduct | null> {
  const ids = workProductIds(input.evidence);
  if (ids.length === 0) return null;

  const [primary] = await sql<PrimaryWorkProduct[]>`
    SELECT
      wp.id,
      CASE
        WHEN wp.public_url ~* '^https?://' THEN wp.public_url
        ELSE '/deliverables/' || wp.id::text || '/open'
      END AS open_url,
      COALESCE(NULLIF(BTRIM(wp.title), ''), NULLIF(BTRIM(wp.filename), ''), 'Deliverable') AS title,
      wp.render_mode
    FROM work_products wp
    JOIN tasks source_task ON source_task.id = wp.task_id
    WHERE wp.id = ANY(${ids}::uuid[])
      AND wp.hive_id = ${input.hiveId}
      AND source_task.goal_id = ${input.goalId}
    ORDER BY
      CASE
        WHEN wp.artifact_kind = 'final_artifact' THEN 0
        WHEN CONCAT_WS(
          ' ',
          wp.title,
          wp.filename,
          wp.file_path,
          wp.artifact_kind,
          source_task.assigned_to,
          source_task.created_by
        ) ~* '(qa|review|compliance|signoff|audit|rework|notes|checklist|doctor|supervisor|peer[- ]?review)' THEN 7
        WHEN wp.artifact_kind = 'landing_page' THEN 1
        WHEN wp.artifact_kind = 'image' THEN 2
        WHEN wp.artifact_kind = 'document' THEN 3
        WHEN wp.artifact_kind = 'report' THEN 4
        WHEN wp.artifact_kind IN ('business_output', 'deliverable', 'asset', 'publication') THEN 5
        ELSE 6
      END,
      CASE wp.render_mode
        WHEN 'external_url' THEN 0
        WHEN 'html' THEN 1
        WHEN 'image' THEN 2
        WHEN 'markdown' THEN 3
        WHEN 'text' THEN 4
        WHEN 'json' THEN 5
        ELSE 6
      END,
      array_position(${ids}::uuid[], wp.id)
    LIMIT 1
  `;

  return primary ?? null;
}

export async function upsertOwnerOutcomeForCompletion(
  sql: QuerySql,
  input: UpsertOwnerOutcomeInput,
): Promise<{ id: string }> {
  const [goal] = await sql<GoalOutcomeContext[]>`
    SELECT h.kind, g.title
    FROM goals g
    JOIN hives h ON h.id = g.hive_id
    WHERE g.id = ${input.goalId}
      AND g.hive_id = ${input.hiveId}
    LIMIT 1
  `;
  if (!goal) throw new Error(`Goal not found for owner outcome: ${input.goalId}`);

  const primary = await selectPrimaryWorkProduct(sql, input);
  const summary = compactText(input.completionSummary, 5_000);
  const [outcome] = await sql<{ id: string }[]>`
    INSERT INTO owner_outcomes (
      hive_id,
      goal_id,
      goal_completion_id,
      summary,
      why_it_matters,
      impact_statement,
      recommended_next_action,
      evidence,
      primary_work_product_id,
      primary_open_url,
      primary_artifact_title,
      primary_artifact_render_mode,
      route_metadata
    )
    VALUES (
      ${input.hiveId},
      ${input.goalId},
      ${input.goalCompletionId},
      ${summary},
      ${whyItMatters(goal.title)},
      ${impactStatement(goal.kind, goal.title)},
      ${recommendedNextAction(primary)},
      ${sql.json(input.evidence as unknown as Parameters<typeof sql.json>[0])},
      ${primary?.id ?? null},
      ${primary?.open_url ?? null},
      ${primary?.title ?? null},
      ${primary?.render_mode ?? null},
      ${sql.json({
        source: "goal_completion",
        createdFromGoalCompletionId: input.goalCompletionId,
      } as unknown as Parameters<typeof sql.json>[0])}
    )
    ON CONFLICT (goal_completion_id) DO UPDATE SET
      summary = EXCLUDED.summary,
      why_it_matters = EXCLUDED.why_it_matters,
      impact_statement = EXCLUDED.impact_statement,
      recommended_next_action = EXCLUDED.recommended_next_action,
      evidence = EXCLUDED.evidence,
      primary_work_product_id = EXCLUDED.primary_work_product_id,
      primary_open_url = EXCLUDED.primary_open_url,
      primary_artifact_title = EXCLUDED.primary_artifact_title,
      primary_artifact_render_mode = EXCLUDED.primary_artifact_render_mode,
      route_metadata = owner_outcomes.route_metadata || EXCLUDED.route_metadata,
      updated_at = NOW()
    RETURNING id
  `;
  if (!outcome) throw new Error("Failed to create owner outcome");
  return outcome;
}
