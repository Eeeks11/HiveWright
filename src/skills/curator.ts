import type { Sql } from "postgres";
import { isAgentCreatedSkill } from "./provenance";
import { archiveSkill } from "./self-creation";

export type SkillLifecycleState = "active" | "stale" | "archived";

export interface SkillCuratorConfig {
  staleAfterDays?: number;
  archiveAfterDays?: number;
}

export interface SkillCuratorTransitionCounts {
  checked: number;
  markedStale: number;
  archived: number;
  reactivated: number;
  skippedPinned: number;
  skippedUserOwned: number;
}

export interface SkillCuratorCandidate {
  id: string;
  slug: string;
  status: string;
  createdBy: string | null;
  curatorState: SkillLifecycleState;
  curatorPinned: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  lastViewedAt: Date | null;
  lastPatchedAt: Date | null;
}

const DEFAULT_STALE_AFTER_DAYS = 30;
const DEFAULT_ARCHIVE_AFTER_DAYS = 90;

function asDate(value: unknown): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value as string);
}

function latestActivity(candidate: SkillCuratorCandidate): Date {
  const timestamps = [
    candidate.lastUsedAt,
    candidate.lastViewedAt,
    candidate.lastPatchedAt,
    candidate.updatedAt,
    candidate.createdAt,
  ].filter((value): value is Date => value instanceof Date && !Number.isNaN(value.getTime()));
  return timestamps.reduce((latest, value) => value > latest ? value : latest, timestamps[0] ?? new Date(0));
}

function mapCandidate(row: Record<string, unknown>): SkillCuratorCandidate {
  return {
    id: row.id as string,
    slug: row.slug as string,
    status: row.status as string,
    createdBy: (row.created_by as string | null) ?? null,
    curatorState: ((row.curator_state as string | null) ?? "active") as SkillLifecycleState,
    curatorPinned: Boolean(row.curator_pinned),
    createdAt: asDate(row.created_at) ?? new Date(),
    updatedAt: asDate(row.updated_at) ?? new Date(),
    lastUsedAt: asDate(row.last_used_at),
    lastViewedAt: asDate(row.last_viewed_at),
    lastPatchedAt: asDate(row.last_patched_at),
  };
}

/**
 * Hermes pattern port: only explicitly agent-created skill candidates are eligible
 * for autonomous lifecycle transitions. User-authored/manual candidates can still
 * be reviewed/published, but the curator must never silently archive them.
 */
export async function listCuratorCandidates(
  sql: Sql,
  hiveId: string,
): Promise<SkillCuratorCandidate[]> {
  const rows = await sql`
    SELECT id,
           slug,
           status,
           created_by,
           curator_state,
           curator_pinned,
           created_at,
           updated_at,
           last_used_at,
           last_viewed_at,
           last_patched_at
    FROM skill_drafts
    WHERE hive_id = ${hiveId}
      AND status IN ('approved', 'published', 'archived')
    ORDER BY updated_at DESC
  `;
  return rows.map((row) => mapCandidate(row));
}

export function planSkillCuratorTransition(
  candidate: SkillCuratorCandidate,
  now: Date = new Date(),
  config: SkillCuratorConfig = {},
): SkillLifecycleState | "skip-pinned" | "skip-user-owned" {
  if (candidate.curatorPinned) return "skip-pinned";
  if (!isAgentCreatedSkill(candidate.createdBy)) return "skip-user-owned";

  const staleAfterDays = config.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const archiveAfterDays = config.archiveAfterDays ?? DEFAULT_ARCHIVE_AFTER_DAYS;
  const idleDays = (now.getTime() - latestActivity(candidate).getTime()) / (1000 * 60 * 60 * 24);

  if (idleDays >= archiveAfterDays) return "archived";
  if (idleDays >= staleAfterDays) return "stale";
  return "active";
}

export async function applySkillCuratorTransitions(
  sql: Sql,
  hiveId: string,
  config: SkillCuratorConfig = {},
  now: Date = new Date(),
): Promise<SkillCuratorTransitionCounts> {
  const counts: SkillCuratorTransitionCounts = {
    checked: 0,
    markedStale: 0,
    archived: 0,
    reactivated: 0,
    skippedPinned: 0,
    skippedUserOwned: 0,
  };
  const candidates = await listCuratorCandidates(sql, hiveId);

  for (const candidate of candidates) {
    counts.checked += 1;
    const planned = planSkillCuratorTransition(candidate, now, config);
    if (planned === "skip-pinned") {
      counts.skippedPinned += 1;
      continue;
    }
    if (planned === "skip-user-owned") {
      counts.skippedUserOwned += 1;
      continue;
    }
    if (planned === candidate.curatorState) continue;

    if (planned === "archived") {
      await archiveSkill(sql, candidate.id, "skill-curator", "Auto-archived after stale agent-created skill candidate went idle.");
      await sql`
        UPDATE skill_drafts
        SET curator_state = 'archived',
            updated_at = NOW()
        WHERE id = ${candidate.id}
      `;
      counts.archived += 1;
      continue;
    }

    await sql`
      UPDATE skill_drafts
      SET curator_state = ${planned},
          updated_at = NOW()
      WHERE id = ${candidate.id}
    `;
    if (planned === "stale") counts.markedStale += 1;
    if (planned === "active") counts.reactivated += 1;
  }

  return counts;
}

export async function pinSkillCandidate(
  sql: Sql,
  draftId: string,
  pinned: boolean,
): Promise<void> {
  const rows = await sql`
    UPDATE skill_drafts
    SET curator_pinned = ${pinned},
        updated_at = NOW()
    WHERE id = ${draftId}
    RETURNING id
  `;
  if (rows.length === 0) throw new Error(`Skill draft not found: ${draftId}`);
}
