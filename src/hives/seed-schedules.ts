import type { Sql } from "postgres";
import { CronExpressionParser } from "cron-parser";
import { normalizeHiveKind, type HiveKind } from "@/hives/kind";

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

type HiveSeedContext = { id: string; name: string; description: string | null; kind?: HiveKind | string | null };

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

const WORLD_SCAN_CRON = "0 7 * * *"; // every day at 07:00 local
const WORLD_SCAN_TITLE = "Daily world scan";

const WORLD_SCAN_BRIEF = (hiveName: string, hiveDescription: string | null) => `
Run the daily world scan for ${hiveName}.

${hiveDescription ? `Hive context:\n${hiveDescription}\n\n` : ""}Your job today is to look for anything that could materially change how
this hive operates, makes money, or competes:

1. Trends, news, or tools released in the last 24-48 hours that are
   relevant to this hive's industry.
2. Competitor moves (pricing, features, launches) worth noting.
3. Regulatory or economic signals that might hit the hive's customers.
4. New AI models, libraries, or workflows that HiveWright itself could
   adopt for this hive's agents.

Produce:

- A concise summary of what you found (5-10 bullet points max).
- For each item that the owner should *act on*, create a Tier 2 decision
  via the create_decision tool with a clear recommendation. Do NOT create
  a decision for items that are just interesting — only act-worthy ones.
- If a decision is a genuine named multi-way choice (for example runtime,
  auth, product, or process paths), populate options[] with stable key,
  human-readable label, consequence/tradeoff, and response/canonicalResponse.
  Keep natural yes/no approval decisions simple without options[].
- Insert any durable facts (seasonal patterns, confirmed competitor
  pricing, regulatory changes) into hive_memory so other roles benefit.

Scope: default web-research allowance. If you can't reach the web, say
so and return what you can infer from the hive's existing memory and
recent work products. Do NOT fabricate facts.

Acceptance: the summary is written; decisions are created for the
items that need action; hive_memory has at least one new entry if
anything durable was learned.
`.trim();

const BUSINESS_DAILY_OPPORTUNITY_SCAN: DefaultScheduleDefinition = {
  key: "daily-world-scan",
  title: WORLD_SCAN_TITLE,
  cronExpression: WORLD_SCAN_CRON,
  tier: "proactive",
  createdBy: SYSTEM_DEFAULT_CREATED_BY,
  buildTemplate: (hive) => ({
    assignedTo: "research-analyst",
    title: WORLD_SCAN_TITLE,
    brief: WORLD_SCAN_BRIEF(hive.name, hive.description),
    qaRequired: false,
    priority: 4,
  }),
};

const KIND_OPERATING_LOOP_DEFINITIONS: Record<HiveKind, DefaultScheduleDefinition[]> = {
  business: [
    BUSINESS_DAILY_OPPORTUNITY_SCAN,
    {
      key: "weekly-business-review",
      title: "Weekly business review",
      kind: "weekly-business-review",
      cronExpression: "0 9 * * 1",
      tier: "proactive",
      createdBy: SYSTEM_DEFAULT_CREATED_BY,
      buildTemplate: (hive) => ({
        kind: "weekly-business-review",
        assignedTo: "performance-analyst",
        title: "Weekly business review",
        brief: `Review ${hive.name}'s revenue path, customer pipeline, fulfilment risks, expenses, owner decisions, and next commercial action. Create owner decisions only for material tradeoffs or approval gates.`,
        qaRequired: false,
        priority: 3,
      }),
    },
  ],
  personal_project: [
    {
      key: "weekly-milestone-review",
      title: "Weekly milestone review",
      kind: "weekly-milestone-review",
      cronExpression: "0 9 * * 1",
      tier: "proactive",
      createdBy: SYSTEM_DEFAULT_CREATED_BY,
      buildTemplate: (hive) => ({
        kind: "weekly-milestone-review",
        assignedTo: "goal-supervisor",
        title: "Weekly milestone review",
        brief: `Review ${hive.name}'s milestones, deliverables, blockers, dependencies, and next useful action. Keep the owner focused on progress toward the defined project outcome.`,
        qaRequired: false,
        priority: 3,
      }),
    },
    {
      key: "project-blocker-check",
      title: "Project blocker check",
      kind: "project-blocker-check",
      cronExpression: "0 10 * * 3",
      tier: "proactive",
      createdBy: SYSTEM_DEFAULT_CREATED_BY,
      buildTemplate: (hive) => ({
        kind: "project-blocker-check",
        assignedTo: "operations-coordinator",
        title: "Project blocker check",
        brief: `Check ${hive.name} for blocked decisions, missing inputs, stale tasks, and owner approvals that could stop the project from moving forward.`,
        qaRequired: false,
        priority: 4,
      }),
    },
  ],
  personal_assistant: [
    {
      key: "daily-admin-digest",
      title: "Daily admin digest",
      kind: "daily-admin-digest",
      cronExpression: "0 8 * * *",
      tier: "proactive",
      createdBy: SYSTEM_DEFAULT_CREATED_BY,
      buildTemplate: (hive) => ({
        kind: "daily-admin-digest",
        assignedTo: "lifestyle-assistant",
        title: "Daily admin digest",
        brief: `Prepare a concise admin digest for ${hive.name}: open requests, reminders, appointments, errands, pending approvals, and any sensitive actions that must wait for owner approval.`,
        qaRequired: false,
        priority: 3,
      }),
    },
    {
      key: "reminder-sweep",
      title: "Reminder sweep",
      kind: "reminder-sweep",
      cronExpression: "0 16 * * *",
      tier: "proactive",
      createdBy: SYSTEM_DEFAULT_CREATED_BY,
      buildTemplate: (hive) => ({
        kind: "reminder-sweep",
        assignedTo: "scheduler",
        title: "Reminder sweep",
        brief: `Sweep ${hive.name} for reminders, follow-ups, date-sensitive tasks, and unresolved owner approvals. Do not send external messages or make commitments without approval.`,
        qaRequired: false,
        priority: 4,
      }),
    },
  ],
  research: [
    {
      key: "source-finding-review",
      title: "Source and finding review",
      kind: "source-finding-review",
      cronExpression: "0 9 * * 2",
      tier: "proactive",
      createdBy: SYSTEM_DEFAULT_CREATED_BY,
      buildTemplate: (hive) => ({
        kind: "source-finding-review",
        assignedTo: "research-analyst",
        title: "Source and finding review",
        brief: `Review ${hive.name}'s questions, sources, findings, confidence levels, unknowns, and recommendation readiness. Separate evidence from inference.`,
        qaRequired: false,
        priority: 3,
      }),
    },
    {
      key: "research-unknowns-check",
      title: "Research unknowns check",
      kind: "research-unknowns-check",
      cronExpression: "0 11 * * 4",
      tier: "proactive",
      createdBy: SYSTEM_DEFAULT_CREATED_BY,
      buildTemplate: (hive) => ({
        kind: "research-unknowns-check",
        assignedTo: "intelligence-analyst",
        title: "Research unknowns check",
        brief: `Check ${hive.name} for unresolved questions, weak sources, stale assumptions, and next evidence-gathering steps.`,
        qaRequired: false,
        priority: 4,
      }),
    },
  ],
  creative: [
    {
      key: "creative-draft-review",
      title: "Creative draft review",
      kind: "creative-draft-review",
      cronExpression: "0 10 * * 2",
      tier: "proactive",
      createdBy: SYSTEM_DEFAULT_CREATED_BY,
      buildTemplate: (hive) => ({
        kind: "creative-draft-review",
        assignedTo: "content-review-agent",
        title: "Creative draft review",
        brief: `Review ${hive.name}'s drafts, assets, variants, owner feedback, brand constraints, and next production step.`,
        qaRequired: false,
        priority: 3,
      }),
    },
    {
      key: "publish-readiness-loop",
      title: "Publish readiness loop",
      kind: "publish-readiness-loop",
      cronExpression: "0 14 * * 4",
      tier: "proactive",
      createdBy: SYSTEM_DEFAULT_CREATED_BY,
      buildTemplate: (hive) => ({
        kind: "publish-readiness-loop",
        assignedTo: "social-media-manager",
        title: "Publish readiness loop",
        brief: `Check ${hive.name}'s publishable assets, review state, channel fit, missing approvals, and delivery checklist.`,
        qaRequired: false,
        priority: 4,
      }),
    },
  ],
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
    key: "ideas-daily-review",
    title: "Ideas daily review",
    kind: "ideas-daily-review",
    cronExpression: "0 9 * * *",
    tier: "proactive",
    createdBy: SYSTEM_DEFAULT_CREATED_BY,
    buildTemplate: () => ({
      kind: "ideas-daily-review",
      assignedTo: "ideas-curator",
      title: "Ideas daily review",
      brief: "(populated at run time)",
    }),
  },
  {
    key: "initiative-evaluation",
    title: "Initiative evaluation",
    kind: "initiative-evaluation",
    cronExpression: "0 * * * *",
    tier: "proactive",
    createdBy: SYSTEM_DEFAULT_CREATED_BY,
    buildTemplate: () => ({
      kind: "initiative-evaluation",
      assignedTo: "initiative-engine",
      title: "Initiative evaluation",
      brief: "(populated at run time)",
    }),
  },
  {
    key: "llm-release-scan",
    title: "Weekly LLM release scan",
    kind: "llm-release-scan",
    cronExpression: "0 8 * * 1",
    tier: "proactive",
    createdBy: SYSTEM_DEFAULT_CREATED_BY,
    buildTemplate: () => ({
      kind: "llm-release-scan",
      assignedTo: "initiative-engine",
      title: "Weekly LLM release scan",
      brief: "(populated at run time)",
    }),
  },
  {
    key: "current-tech-research-daily",
    title: "Current tech research daily cycle",
    kind: "current-tech-research-daily",
    cronExpression: "30 8 * * *",
    tier: "proactive",
    createdBy: SYSTEM_DEFAULT_CREATED_BY,
    buildTemplate: () => ({
      kind: "current-tech-research-daily",
      assignedTo: "goal-supervisor",
      title: "Current tech research daily cycle",
      brief: "(populated at run time)",
    }),
  },
  {
    key: "task-quality-feedback-sample",
    title: "Task quality feedback sample",
    kind: "task-quality-feedback-sample",
    cronExpression: "0 10 * * *",
    tier: "proactive",
    createdBy: SYSTEM_DEFAULT_CREATED_BY,
    buildTemplate: () => ({
      kind: "task-quality-feedback-sample",
      assignedTo: "initiative-engine",
      title: "Task quality feedback sample",
      brief: "(populated at run time)",
    }),
  },
];

const ALL_DEFAULT_SCHEDULE_DEFINITIONS = [
  ...COMMON_DEFAULT_SCHEDULE_DEFINITIONS,
  ...Object.values(KIND_OPERATING_LOOP_DEFINITIONS).flat(),
];

export const DEFAULT_SCHEDULE_REGISTRY = ALL_DEFAULT_SCHEDULE_DEFINITIONS.map((definition) => ({
  key: definition.key,
  title: definition.title,
  kind: definition.kind,
  cronExpression: definition.cronExpression,
  tier: definition.tier,
}));

function defaultScheduleDefinitionsForHive(hive: HiveSeedContext): DefaultScheduleDefinition[] {
  const kind = normalizeHiveKind(hive.kind);
  return [
    ...KIND_OPERATING_LOOP_DEFINITIONS[kind],
    ...COMMON_DEFAULT_SCHEDULE_DEFINITIONS,
  ];
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

  for (const definition of defaultScheduleDefinitionsForHive(hive)) {
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
