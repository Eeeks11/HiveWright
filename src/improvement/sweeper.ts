import type { Sql } from "postgres";
import { findEvolutionCandidates, proposeRoleUpdate } from "../memory/role-evolution";
import { loadModelEfficiencyConfig } from "./model-efficiency-config";
import { applicableQualityFloor, loadQualityControlsConfig } from "../quality/quality-config";
import { calculateRoleQualityScore, calculateRoleQualityScoreForTaskIds } from "../quality/score";
import { maybeCreateQualityDoctorForRoleWindow } from "../quality/doctor";

/**
 * System-improvement agent. Runs on a weekly schedule (and on demand via
 * POST /api/improvement/run). For each hive:
 *
 *   1. Role-template evolution — reuses memory/role-evolution to spot
 *      high-traffic role-memory entries and propose baking them into the
 *      role template (Tier 2 decision). Dedupes against pending proposals.
 *   2. Role-level reliability scan — if a role's failure rate is >=40% in
 *      the last 7 days AND it ran ≥5 tasks, propose "review this role" as
 *      a Tier 2 decision so the owner can either swap models, narrow
 *      brief quality, or retire the role.
 *
 * The sweeper is deliberately read-mostly: it never mutates role runtime
 * config. Model feedback belongs in task-quality/model-routing evidence and
 * owner-visible decisions; dispatch-time auto routing chooses the concrete
 * model per task.
 */

export interface HiveSweepResult {
  hiveId: string;
  evolutionProposals: number;
  reliabilityProposals: number;
  efficiencyProposals: number;
  errors: string[];
}

export async function runImprovementSweep(
  sql: Sql,
): Promise<HiveSweepResult[]> {
  // One-time backfill: sweeper-produced decisions created before the
  // autonomy switchover were left as 'pending' and cluttered the owner
  // inbox. Flip them to 'auto_approved' so the brief stops counting them
  // as blockers. Idempotent — running once is enough, subsequent calls
  // match zero rows.
  await sql`
    UPDATE decisions
    SET status = 'auto_approved'
    WHERE status = 'pending'
      AND (
        title LIKE 'Role update proposed:%'
        OR title LIKE 'Role reliability concern:%'
        OR title LIKE 'Model efficiency review:%'
      )
  `;

  const hives = await sql<{ id: string }[]>`SELECT id FROM hives`;
  const results: HiveSweepResult[] = [];

  for (const hive of hives) {
    const r: HiveSweepResult = {
      hiveId: hive.id,
      evolutionProposals: 0,
      reliabilityProposals: 0,
      efficiencyProposals: 0,
      errors: [],
    };

    try {
      const candidates = await findEvolutionCandidates(sql, hive.id);
      for (const c of candidates) {
        try {
          await proposeRoleUpdate(sql, c);
          r.evolutionProposals++;
        } catch (e) {
          r.errors.push(
            `evolution ${c.roleSlug}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } catch (e) {
      r.errors.push(
        `evolution candidates: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    try {
      const lowQualityRoles = await findLowReliabilityRoles(sql, hive.id);
      for (const role of lowQualityRoles) {
        try {
          await proposeReliabilityReview(sql, hive.id, role);
          r.reliabilityProposals++;
        } catch (e) {
          r.errors.push(
            `reliability ${role.roleSlug}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } catch (e) {
      r.errors.push(
        `reliability scan: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    try {
      await triggerQualityDoctorsForLowRoleWindows(sql, hive.id);
    } catch (e) {
      r.errors.push(
        `quality-doctor scan: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    try {
      await processModelSwapWatches(sql, hive.id);
      const efficiencyCandidates = await findEfficiencyCandidates(sql, hive.id);
      for (const c of efficiencyCandidates) {
        try {
          const created = await proposeEfficiencyReview(sql, hive.id, c);
          if (created) r.efficiencyProposals++;
        } catch (e) {
          r.errors.push(
            `efficiency ${c.roleSlug}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } catch (e) {
      r.errors.push(
        `efficiency scan: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    results.push(r);
  }

  return results;
}

async function triggerQualityDoctorsForLowRoleWindows(sql: Sql, hiveId: string): Promise<void> {
  const roles = await sql<{ slug: string }[]>`
    SELECT DISTINCT assigned_to AS slug
    FROM tasks
    WHERE hive_id = ${hiveId}::uuid
      AND status = 'completed'
      AND COALESCE(completed_at, updated_at, created_at) > NOW() - INTERVAL '30 days'
  `;
  for (const role of roles) {
    await maybeCreateQualityDoctorForRoleWindow(sql, hiveId, role.slug);
  }
}

interface RoleReliability {
  roleSlug: string;
  attempted: number;
  failed: number;
  failureRate: number;
}

async function findLowReliabilityRoles(
  sql: Sql,
  hiveId: string,
): Promise<RoleReliability[]> {
  const rows = await sql`
    SELECT assigned_to                                         AS "roleSlug",
           COUNT(*)                                            AS "attempted",
           COUNT(*) FILTER (WHERE status IN ('failed','unresolvable')) AS "failed"
    FROM tasks
    WHERE hive_id = ${hiveId}::uuid
      AND started_at > NOW() - INTERVAL '7 days'
      AND status IN ('completed','failed','unresolvable')
    GROUP BY assigned_to
    HAVING COUNT(*) >= 5
       AND (COUNT(*) FILTER (WHERE status IN ('failed','unresolvable')))::float
             / COUNT(*) >= 0.4
  `;
  return (rows as unknown as { roleSlug: string; attempted: string; failed: string }[]).map(
    (r) => ({
      roleSlug: r.roleSlug,
      attempted: Number(r.attempted),
      failed: Number(r.failed),
      failureRate: Number(r.failed) / Number(r.attempted),
    }),
  );
}

async function proposeReliabilityReview(
  sql: Sql,
  hiveId: string,
  r: RoleReliability,
): Promise<void> {
  // Dedupe: skip if a matching proposal is already pending OR auto_approved.
  const title = `Role reliability concern: ${r.roleSlug}`;
  const [existing] = await sql`
    SELECT id FROM decisions
    WHERE hive_id = ${hiveId}::uuid
      AND title = ${title}
      AND status IN ('pending', 'auto_approved')
  `;
  if (existing) return;

  const pct = Math.round(r.failureRate * 1000) / 10;

  const action = "No role runtime config was changed. Auto routing will continue selecting the concrete model per task using route health, task profile, hive policy, and accumulated quality feedback.";

  await sql`
    INSERT INTO decisions (hive_id, title, context, recommendation, priority, status)
    VALUES (
      ${hiveId}::uuid,
      ${title},
      ${`${r.roleSlug} attempted ${r.attempted} tasks in the last 7 days and ${r.failed} failed (${pct}% failure rate). Threshold is 40%.\n\nObserved: ${action}`},
      'Review task briefs, role instructions, routing policy, or model health if failures persist. Do not pin the role to a model unless there is a specific runtime constraint.',
      'normal',
      'auto_approved'
    )
  `;
}

interface RoleEfficiency {
  roleSlug: string;
  modelUsed: string;
  completed: number;
  avgCostCents: number;
  totalCostCents: number;
}

/**
 * Model-efficiency: spot roles that spend a lot of cents per successful
 * task relative to peers doing similar work. Crude heuristic — cost per
 * completed task >= $0.50 AND >=5 completions AND the role's current
 * model is one of the "expensive" tiers (Sonnet/Opus/GPT-4o-class).
 * Cheap local roles and zero-cost Ollama installs are ignored.
 */
async function findEfficiencyCandidates(
  sql: Sql,
  hiveId: string,
): Promise<RoleEfficiency[]> {
  const config = await loadModelEfficiencyConfig(sql);
  const rows = await sql`
    SELECT assigned_to                    AS "roleSlug",
           COALESCE(model_used, '')        AS "modelUsed",
           COUNT(*)                        AS "completed",
           COALESCE(SUM(cost_cents), 0)::int AS "totalCostCents",
           COALESCE(AVG(cost_cents), 0)::int AS "avgCostCents"
    FROM tasks
    WHERE hive_id = ${hiveId}::uuid
      AND status = 'completed'
      AND COALESCE(started_at, updated_at) > NOW() - INTERVAL '30 days'
    GROUP BY assigned_to, COALESCE(model_used, '')
    HAVING COUNT(*) >= ${config.minCompletionsThreshold}
       AND COALESCE(AVG(cost_cents), 0) >= ${config.avgCostCentsThreshold}
  `;
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    roleSlug: r.roleSlug as string,
    modelUsed: r.modelUsed as string,
    completed: Number(r.completed),
    avgCostCents: Number(r.avgCostCents),
    totalCostCents: Number(r.totalCostCents),
  }));
}

async function proposeEfficiencyReview(
  sql: Sql,
  hiveId: string,
  c: RoleEfficiency,
): Promise<boolean> {
  const [role] = await sql<{
    recommended_model: string | null;
    owner_pinned: boolean;
  }[]>`
    SELECT recommended_model, COALESCE(owner_pinned, false) AS owner_pinned
    FROM role_templates
    WHERE slug = ${c.roleSlug}
  `;
  if (!role || role.owner_pinned) return false;

  const qualityConfig = await loadQualityControlsConfig(sql, hiveId);
  const floor = applicableQualityFloor(qualityConfig, c.roleSlug);
  const quality = await calculateRoleQualityScore(sql, hiveId, c.roleSlug);
  if (quality.qualityScore >= floor) return false;

  const title = `Model efficiency review: ${c.roleSlug}`;
  const [existing] = await sql`
    SELECT id FROM decisions
    WHERE hive_id = ${hiveId}::uuid
      AND title = ${title}
      AND status IN ('pending', 'auto_approved')
  `;
  if (existing) return false;

  const avgDollar = (c.avgCostCents / 100).toFixed(2);
  const totalDollar = (c.totalCostCents / 100).toFixed(2);
  const cheaperModel = suggestCheaperModel(c.modelUsed);

  const action = cheaperModel
    ? `No role runtime config was changed. Candidate cheaper peer model ${cheaperModel} should be considered by auto-routing only if hive policy, model health, and task-profile outcome feedback support it.`
    : `No role runtime config was changed. No deterministic peer-model suggestion is available; auto routing should continue using model health, task profile, hive policy, and outcome feedback.`;

  await sql`
    INSERT INTO decisions (hive_id, title, context, recommendation, priority, status)
    VALUES (
      ${hiveId}::uuid,
      ${title},
      ${`${c.roleSlug} (running ${c.modelUsed || "unknown model"}) completed ${c.completed} tasks in the last 30 days at an average of $${avgDollar}/task (${totalDollar} total). Above the $0.50/task threshold.\n\nQuality gate: current composite score ${quality.qualityScore.toFixed(3)} is below floor ${floor.toFixed(2)} (${quality.basis}).\n\nObserved: ${action}`},
      'Leave the role on Auto. Review hive routing policy/model allowlists only if the router keeps selecting poor-value models after enough outcome evidence accumulates.',
      'normal',
      'auto_approved'
    )
  `;
  return true;
}

async function processModelSwapWatches(sql: Sql, hiveId: string): Promise<void> {
  const watches = await sql<{
    id: string;
    role_slug: string;
    from_model: string | null;
    to_model: string;
    tasks_to_watch: number;
    quality_floor: number;
    created_at: Date;
  }[]>`
    SELECT id, role_slug, from_model, to_model, tasks_to_watch, quality_floor, created_at
    FROM role_model_swap_watches
    WHERE hive_id = ${hiveId}::uuid
      AND status = 'watching'
    ORDER BY created_at ASC
  `;

  for (const watch of watches) {
    const watchedTasks = await sql<{ id: string }[]>`
      SELECT id
      FROM tasks
      WHERE hive_id = ${hiveId}::uuid
        AND assigned_to = ${watch.role_slug}
        AND status = 'completed'
        AND COALESCE(completed_at, updated_at) > ${watch.created_at}
      ORDER BY COALESCE(completed_at, updated_at, created_at) ASC
      LIMIT ${watch.tasks_to_watch}
    `;
    const count = watchedTasks.length;
    if (count < Number(watch.tasks_to_watch)) {
      await sql`
        UPDATE role_model_swap_watches
        SET tasks_seen = ${count}, updated_at = NOW()
        WHERE id = ${watch.id}
      `;
      continue;
    }

    const watchedTaskIds = watchedTasks.map((task) => task.id);
    const quality = await calculateRoleQualityScoreForTaskIds(sql, hiveId, watch.role_slug, watchedTaskIds);
    if (quality.qualityScore < Number(watch.quality_floor) && watch.from_model) {
      const [decision] = await sql<{ id: string }[]>`
        INSERT INTO decisions (hive_id, title, context, recommendation, priority, status, kind)
        VALUES (
          ${hiveId}::uuid,
          ${`Model swap watch failed: ${watch.role_slug}`},
          ${`A legacy model-swap watch compared ${watch.from_model} against ${watch.to_model}. After ${count} completed watched tasks, composite quality was ${quality.qualityScore.toFixed(3)} below floor ${Number(watch.quality_floor).toFixed(2)}. No role runtime config was changed; leave the role on Auto and use this evidence in routing policy/outcome scoring.`},
          'Review model health, hive routing policy, and task-profile outcome evidence before pinning any role to a model.',
          'normal',
          'pending',
          'model_swap_watch_failed'
        )
        RETURNING id
      `;
      await sql`
        UPDATE role_model_swap_watches
        SET status = 'failed',
            tasks_seen = ${count},
            decision_id = ${decision.id},
            updated_at = NOW()
        WHERE id = ${watch.id}
      `;
    } else {
      await sql`
        UPDATE role_model_swap_watches
        SET status = 'passed',
            tasks_seen = ${count},
            updated_at = NOW()
        WHERE id = ${watch.id}
      `;
    }
  }
}

export function suggestCheaperModel(currentModel: string): string | null {
  if (!currentModel) return null;
  if (currentModel.startsWith("anthropic/claude-opus"))
    return "anthropic/claude-sonnet-4-6";
  if (currentModel.startsWith("anthropic/claude-sonnet")) return null;
  if (currentModel === "openai/gpt-4o") return "openai/gpt-4o-mini";
  if (currentModel.startsWith("openai-codex/gpt-5"))
    return "a local Ollama model";
  return null;
}
