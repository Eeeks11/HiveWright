const INTERNAL_ROLES = [
  "doctor",
  "hive-supervisor",
  "quality-reviewer",
  "system-health-auditor",
] as const;

const INTERNAL_TASK_CREATORS = [
  "dispatcher",
  "pipeline",
  "qa-fixture",
  "system",
  "system:seed-default-schedules",
  "watchdog",
] as const;

const INTERNAL_KINDS = [
  "system_error",
  "supervisor_flagged",
  "quality_doctor_recommendation",
  "unresolvable_task_triage",
] as const;

export const INTERNAL_DECISION_SQL = `(
  d.is_qa_fixture = true
  OR h.is_system_fixture = true
  OR d.kind IN (${INTERNAL_KINDS.map((kind) => `'${kind}'`).join(", ")})
  OR COALESCE(d.options #>> '{lane}', 'owner') = 'ai_peer'
  OR COALESCE(d.options #>> '{provenance}', '') IN ('ai_peer_feedback_sampler')
  OR COALESCE(d.options #>> '{ownerActionRequired}', 'true') = 'false'
  OR COALESCE(d.options #>> '{internal}', 'false') = 'true'
  OR COALESCE(d.options #>> '{system}', 'false') = 'true'
  OR COALESCE(d.options #>> '{systemInternal}', 'false') = 'true'
  OR COALESCE(t.assigned_to, '') IN (${INTERNAL_ROLES.map((role) => `'${role}'`).join(", ")})
  OR COALESCE(t.created_by, '') IN (${INTERNAL_TASK_CREATORS.map((creator) => `'${creator}'`).join(", ")})
  OR LOWER(d.title) LIKE 'ai peer quality review:%'
  OR LOWER(d.title) LIKE '%heartbeat%'
  OR LOWER(d.title) LIKE '%watchdog%'
  OR LOWER(d.context) LIKE '%hive supervisor heartbeat%'
  OR LOWER(d.context) LIKE '%watchdog%'
)`;

export const OWNER_ACTION_REQUIRED_SQL = `(NOT ${INTERNAL_DECISION_SQL})`;

export const OWNER_DECISION_INBOX_KIND_SQL = `(
  d.kind <> 'system_error'
  AND d.kind <> 'task_quality_feedback'
)`;

export const OWNER_DECISION_INBOX_SQL = `(
  ${OWNER_DECISION_INBOX_KIND_SQL}
  AND ${OWNER_ACTION_REQUIRED_SQL}
)`;

export const OWNER_ACTION_REQUIRED_ORDER_SQL = `
  CASE WHEN ${OWNER_ACTION_REQUIRED_SQL} THEN 0 ELSE 1 END
`;

export const INTERNAL_DECISION_REASON_SQL = `
  CASE
    WHEN d.is_qa_fixture = true THEN 'qa_fixture'
    WHEN h.is_system_fixture = true THEN 'system_fixture_hive'
    WHEN d.kind IN (${INTERNAL_KINDS.map((kind) => `'${kind}'`).join(", ")}) THEN 'internal_kind'
    WHEN COALESCE(d.options #>> '{lane}', 'owner') = 'ai_peer' THEN 'ai_peer_lane'
    WHEN COALESCE(d.options #>> '{provenance}', '') IN ('ai_peer_feedback_sampler') THEN 'internal_provenance'
    WHEN COALESCE(d.options #>> '{ownerActionRequired}', 'true') = 'false' THEN 'owner_action_not_required'
    WHEN COALESCE(d.options #>> '{internal}', 'false') = 'true'
      OR COALESCE(d.options #>> '{system}', 'false') = 'true'
      OR COALESCE(d.options #>> '{systemInternal}', 'false') = 'true' THEN 'structured_internal_marker'
    WHEN COALESCE(t.assigned_to, '') IN (${INTERNAL_ROLES.map((role) => `'${role}'`).join(", ")}) THEN 'internal_task_role'
    WHEN COALESCE(t.created_by, '') IN (${INTERNAL_TASK_CREATORS.map((creator) => `'${creator}'`).join(", ")}) THEN 'internal_task_creator'
    WHEN LOWER(d.title) LIKE 'ai peer quality review:%' THEN 'legacy_ai_peer_title'
    WHEN LOWER(d.title) LIKE '%heartbeat%'
      OR LOWER(d.title) LIKE '%watchdog%'
      OR LOWER(d.context) LIKE '%hive supervisor heartbeat%'
      OR LOWER(d.context) LIKE '%watchdog%' THEN 'legacy_internal_text'
    ELSE NULL
  END
`;

export function shouldIncludeInternalSystem(value: string | null): boolean {
  return value === "true" || value === "1" || value === "yes";
}
