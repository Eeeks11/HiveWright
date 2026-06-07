import type { Sql } from "postgres";
import { CronExpressionParser } from "cron-parser";

const SYSTEM_DEFAULT_ORIGIN_TYPE = "system_default";
const SYSTEM_DEFAULT_CREATED_BY = "system:seed-default-schedules";

type DefaultScheduleTier = "core" | "proactive";

type ScheduleTemplate = {
  kind?: string;
  goalId?: string | null;
  assignedTo: string;
  title: string;
  brief: string;
  qaRequired?: boolean;
  priority?: number;
};

type HiveSeedContext = { id: string; name: string; description: string | null; kind?: string | null };

type InitialNextRunAt = "now-plus-1-minute" | "cron-next";

type DefaultScheduleDefinition = {
  key: string;
  title: string;
  kind?: string;
  cronExpression: string;
  tier: DefaultScheduleTier;
  createdBy: typeof SYSTEM_DEFAULT_CREATED_BY;
  initialNextRunAt?: InitialNextRunAt;
  buildTemplate(hive: HiveSeedContext): ScheduleTemplate;
};

export interface SeedResult {
  created: number;
  skipped: number;
}

export type SeedDefaultSchedulesOptions = {
  coreEnabled?: boolean;
  proactiveEnabled?: boolean;
  /** @deprecated Use coreEnabled/proactiveEnabled. Kept for older callers. */
  enabled?: boolean;
};

const COMMON_DEFAULT_SCHEDULE_DEFINITIONS: DefaultScheduleDefinition[] = [
  {
    key: "hive-supervisor-heartbeat",
    title: "Hive supervisor heartbeat",
    kind: "hive-supervisor-heartbeat",
    cronExpression: "*/15 * * * *",
    tier: "core",
    createdBy: SYSTEM_DEFAULT_CREATED_BY,
    initialNextRunAt: "now-plus-1-minute",
    buildTemplate: () => ({
      kind: "hive-supervisor-heartbeat",
      assignedTo: "hive-supervisor",
      title: "Hive supervisor heartbeat",
      brief: "(populated at run time)",
    }),
  },
  {
    key: "strategic-initiative-evaluation",
    title: "Strategic initiative evaluation",
    kind: "strategic-initiative-evaluation",
    cronExpression: "0 */6 * * *",
    tier: "proactive",
    createdBy: SYSTEM_DEFAULT_CREATED_BY,
    buildTemplate: () => ({
      kind: "strategic-initiative-evaluation",
      assignedTo: "initiative-engine",
      title: "Strategic initiative evaluation",
      brief: "Hive-scoped mission/target review; starts or advances work only when a clear high-leverage next move exists.",
      qaRequired: false,
      priority: 3,
    }),
  },
];

const ALL_DEFAULT_SCHEDULE_DEFINITIONS = [...COMMON_DEFAULT_SCHEDULE_DEFINITIONS];

export const DEFAULT_SCHEDULE_REGISTRY = ALL_DEFAULT_SCHEDULE_DEFINITIONS.map((definition) => ({
  key: definition.key,
  title: definition.title,
  kind: definition.kind,
  cronExpression: definition.cronExpression,
  tier: definition.tier,
}));

function defaultScheduleDefinitionsForHive(): DefaultScheduleDefinition[] {
  return COMMON_DEFAULT_SCHEDULE_DEFINITIONS;
}

function legacyJsonFieldPattern(field: "kind" | "title", value: string): string {
  const escaped = value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  return `"${field}"[[:space:]]*:[[:space:]]*"${escaped}"`;
}

async function hasScheduleWithOrigin(sql: Sql, hiveId: string, originKey: string): Promise<boolean> {
  const rows = await sql`
    SELECT id FROM schedules
    WHERE hive_id = ${hiveId}::uuid
      AND origin_type = ${SYSTEM_DEFAULT_ORIGIN_TYPE}
      AND origin_key = ${originKey}
    LIMIT 1
  `;
  return rows.length > 0;
}

async function markLegacyDefaultIfPresent(
  sql: Sql,
  hiveId: string,
  definition: DefaultScheduleDefinition,
): Promise<boolean> {
  const rows = definition.kind
    ? await sql`
        UPDATE schedules
        SET origin_type = ${SYSTEM_DEFAULT_ORIGIN_TYPE},
            origin_key = ${definition.key}
        WHERE id = (
          SELECT id FROM schedules
          WHERE hive_id = ${hiveId}::uuid
            AND COALESCE(origin_type, 'custom') = 'custom'
            AND (
              task_template ->> 'kind' = ${definition.kind}
              OR (
                jsonb_typeof(task_template) = 'string'
                AND task_template #>> '{}' ~ ${legacyJsonFieldPattern("kind", definition.kind)}
              )
            )
          ORDER BY created_at ASC
          LIMIT 1
        )
        RETURNING id
      `
    : await sql`
        UPDATE schedules
        SET origin_type = ${SYSTEM_DEFAULT_ORIGIN_TYPE},
            origin_key = ${definition.key}
        WHERE id = (
          SELECT id FROM schedules
          WHERE hive_id = ${hiveId}::uuid
            AND COALESCE(origin_type, 'custom') = 'custom'
            AND (
              task_template ->> 'title' = ${definition.title}
              OR (
                jsonb_typeof(task_template) = 'string'
                AND task_template #>> '{}' ~ ${legacyJsonFieldPattern("title", definition.title)}
              )
            )
          ORDER BY created_at ASC
          LIMIT 1
        )
        RETURNING id
      `;
  return rows.length > 0;
}

function nextRunFor(definition: DefaultScheduleDefinition): Date {
  if (definition.initialNextRunAt === "now-plus-1-minute") {
    return new Date(Date.now() + 60_000);
  }
  return CronExpressionParser.parse(definition.cronExpression).next().toDate();
}

function enabledFor(definition: DefaultScheduleDefinition, options: SeedDefaultSchedulesOptions): boolean {
  if (definition.tier === "core") {
    return options.coreEnabled ?? options.enabled ?? true;
  }
  return options.proactiveEnabled ?? options.enabled ?? true;
}

export async function seedDefaultSchedules(
  sql: Sql,
  hive: HiveSeedContext,
  options: SeedDefaultSchedulesOptions = {},
): Promise<SeedResult> {
  const result: SeedResult = { created: 0, skipped: 0 };

  for (const definition of defaultScheduleDefinitionsForHive()) {
    if (await hasScheduleWithOrigin(sql, hive.id, definition.key)) {
      result.skipped++;
      continue;
    }

    if (await markLegacyDefaultIfPresent(sql, hive.id, definition)) {
      result.skipped++;
      continue;
    }

    await sql`
      INSERT INTO schedules (
        hive_id,
        cron_expression,
        task_template,
        enabled,
        next_run_at,
        created_by,
        origin_type,
        origin_key
      )
      VALUES (
        ${hive.id}::uuid,
        ${definition.cronExpression},
        ${sql.json(definition.buildTemplate(hive))},
        ${enabledFor(definition, options)},
        ${nextRunFor(definition)},
        ${definition.createdBy},
        ${SYSTEM_DEFAULT_ORIGIN_TYPE},
        ${definition.key}
      )
    `;
    result.created++;
  }

  return result;
}
