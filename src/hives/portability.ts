import type { Sql, TransactionSql } from "postgres";
import { getConnectorDefinition } from "@/connectors/registry";
import { hiveProjectsPath } from "@/hives/workspace-root";

export const HIVE_PORTABILITY_KIND = "hivewright.hive-template";
export const HIVE_PORTABILITY_VERSION = 1;

export type HivePortableRole = {
  slug: string;
  name: string;
  department: string | null;
  type: string;
  delegatesTo: string[];
  recommendedModel: string | null;
  fallbackModel: string | null;
  adapterType: string;
  fallbackAdapterType: string | null;
  skills: string[];
  toolsConfig: Record<string, unknown> | null;
  roleMd: string | null;
  soulMd: string | null;
  toolsMd: string | null;
  terminal: boolean;
  concurrencyLimit: number;
};

export type HivePortablePackage = {
  manifest: {
    kind: typeof HIVE_PORTABILITY_KIND;
    version: typeof HIVE_PORTABILITY_VERSION;
    source: "hivewright";
  };
  hive: {
    slug: string;
    name: string;
    type: string;
    description: string | null;
    mission: string | null;
    softwareStack: string | null;
    aiBudgetCapCents: number | null;
    aiBudgetWindow: string;
  };
  roles: HivePortableRole[];
  connectors: Array<{
    connectorSlug: string;
    displayName: string;
    config: Record<string, unknown>;
    grantedScopes: string[];
    status: "active" | "disabled";
    credentialId: null;
    envInputs: Array<{
      key: string;
      field: string;
      label: string;
      required: boolean;
      secret: boolean;
    }>;
  }>;
  policies: Array<{
    name: string;
    enabled: boolean;
    connector: string | null;
    operation: string | null;
    effectType: string | null;
    effect: "allow" | "require_approval" | "block";
    roleSlug: string | null;
    priority: number;
    conditions: Record<string, unknown>;
    reason: string | null;
    description: string | null;
  }>;
  schedules: Array<{
    cronExpression: string;
    taskTemplate: Record<string, unknown>;
    enabled: boolean;
    originType: string;
    originKey: string | null;
    createdBy: string;
  }>;
  goals: Array<{
    ref: string;
    title: string;
    description: string | null;
    priority: number;
    status: "active" | "pending";
    budgetCents: number | null;
  }>;
  tasks: Array<{
    title: string;
    brief: string;
    assignedTo: string;
    createdBy: string;
    status: "pending";
    priority: number;
    budgetCents: number | null;
    qaRequired: boolean;
    acceptanceCriteria: string | null;
    goalRef: string | null;
  }>;
};

export type HiveImportOptions = {
  slug: string;
  name: string;
  env?: Record<string, string | undefined>;
  collisionStrategy?: "reject" | "rename";
};

export type HiveImportPreview = {
  canImport: boolean;
  target: { slug: string; name: string };
  collisions: Array<{ field: "slug"; value: string; strategy: "reject" | "rename" }>;
  missingEnvInputs: string[];
  missingRoles: string[];
  warnings: string[];
  summary: {
    roles: number;
    connectors: number;
    policies: number;
    schedules: number;
    goals: number;
    tasks: number;
  };
};

type SqlExecutor = Sql | TransactionSql;

type HiveRow = {
  id: string;
  slug: string;
  name: string;
  type: string;
  description: string | null;
  mission: string | null;
  software_stack: string | null;
  ai_budget_cap_cents: number | null;
  ai_budget_window: string;
};

const HIVE_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,63}$/;
const PORTABLE_GOAL_STATUSES = new Set(["active", "pending"]);

export async function exportHiveTemplate(sql: Sql, hiveId: string): Promise<HivePortablePackage> {
  const [hive] = await sql<HiveRow[]>`
    SELECT id, slug, name, type, description, mission, software_stack, ai_budget_cap_cents, ai_budget_window
    FROM hives
    WHERE id = ${hiveId}::uuid
    LIMIT 1
  `;
  if (!hive) throw new Error("Hive not found");

  const [connectors, policies, schedules, goals, tasks] = await Promise.all([
    loadPortableConnectors(sql, hiveId),
    loadPortablePolicies(sql, hiveId),
    loadPortableSchedules(sql, hiveId),
    loadPortableGoals(sql, hiveId),
    loadPortableTasks(sql, hiveId),
  ]);
  const roles = await loadPortableRoles(sql, collectRoleSlugs({ policies, schedules, tasks }));

  return stablePackage({
    manifest: {
      kind: HIVE_PORTABILITY_KIND,
      version: HIVE_PORTABILITY_VERSION,
      source: "hivewright",
    },
    hive: {
      slug: hive.slug,
      name: hive.name,
      type: hive.type,
      description: hive.description,
      mission: hive.mission,
      softwareStack: hive.software_stack,
      aiBudgetCapCents: hive.ai_budget_cap_cents,
      aiBudgetWindow: hive.ai_budget_window,
    },
    roles,
    connectors,
    policies,
    schedules,
    goals,
    tasks,
  });
}

export async function previewHiveTemplateImport(
  sql: Sql,
  pkg: HivePortablePackage,
  options: HiveImportOptions,
): Promise<HiveImportPreview> {
  assertSupportedPackage(pkg);
  const slug = normalizeSlug(options.slug);
  const name = options.name.trim();
  if (!name) throw new Error("Target hive name is required");

  const strategy = options.collisionStrategy ?? "reject";
  const collisions: HiveImportPreview["collisions"] = [];
  const existing = await sql<{ id: string }[]>`SELECT id FROM hives WHERE slug = ${slug} LIMIT 1`;
  if (existing.length > 0) collisions.push({ field: "slug", value: slug, strategy });

  const requiredEnvKeys = new Set<string>();
  for (const connector of pkg.connectors) {
    for (const input of connector.envInputs) {
      if (input.required) requiredEnvKeys.add(input.key);
    }
  }
  const missingEnvInputs = Array.from(requiredEnvKeys)
    .filter((key) => !options.env?.[key]?.trim())
    .sort();

  const roleRows = pkg.roles.length === 0
    ? []
    : await sql<{ slug: string }[]>`
        SELECT slug
        FROM role_templates
        WHERE slug IN ${sql(pkg.roles.map((role) => role.slug))}
      `;
  const existingRoles = new Set(roleRows.map((row) => row.slug));
  const missingRoles = pkg.roles
    .map((role) => role.slug)
    .filter((slug) => !existingRoles.has(slug))
    .sort();

  const canImport = collisions.every((collision) => collision.strategy === "rename")
    && missingRoles.length === 0;

  return {
    canImport,
    target: { slug, name },
    collisions,
    missingEnvInputs,
    missingRoles,
    warnings: buildWarnings(pkg),
    summary: {
      roles: pkg.roles.length,
      connectors: pkg.connectors.length,
      policies: pkg.policies.length,
      schedules: pkg.schedules.length,
      goals: pkg.goals.length,
      tasks: pkg.tasks.length,
    },
  };
}

export async function importHiveTemplate(sql: Sql, pkg: HivePortablePackage, options: HiveImportOptions) {
  const preview = await previewHiveTemplateImport(sql, pkg, options);
  if (!preview.canImport) {
    throw new Error("Hive package cannot be imported until preview issues are resolved");
  }

  return await sql.begin(async (tx) => {
    const [hive] = await tx<{ id: string; slug: string; name: string; type: string }[]>`
      INSERT INTO hives (
        name, slug, type, description, mission, software_stack, workspace_path,
        ai_budget_cap_cents, ai_budget_window
      )
      VALUES (
        ${preview.target.name},
        ${preview.target.slug},
        ${pkg.hive.type},
        ${pkg.hive.description},
        ${pkg.hive.mission},
        ${pkg.hive.softwareStack},
        ${hiveProjectsPath(preview.target.slug)},
        ${pkg.hive.aiBudgetCapCents},
        ${pkg.hive.aiBudgetWindow}
      )
      RETURNING id, slug, name, type
    `;

    for (const connector of pkg.connectors) {
      await insertConnector(tx, hive.id, connector);
    }
    for (const policy of pkg.policies) {
      await tx`
        INSERT INTO action_policies (
          hive_id, name, enabled, connector, operation, effect_type, effect, role_slug,
          priority, conditions, reason, description, created_by
        )
        VALUES (
          ${hive.id}::uuid,
          ${policy.name},
          ${policy.enabled},
          ${policy.connector},
          ${policy.operation},
          ${policy.effectType},
          ${policy.effect},
          ${policy.roleSlug},
          ${policy.priority},
          ${tx.json(policy.conditions as never)},
          ${policy.reason},
          ${policy.description},
          'portability-import'
        )
      `;
    }
    for (const schedule of pkg.schedules) {
      await tx`
        INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, origin_type, origin_key, created_by)
        VALUES (
          ${hive.id}::uuid,
          ${schedule.cronExpression},
          ${tx.json(schedule.taskTemplate as never)},
          ${schedule.enabled},
          ${schedule.originType},
          ${schedule.originKey},
          ${schedule.createdBy || "portability-import"}
        )
      `;
    }

    const goalIdsByRef = new Map<string, string>();
    for (const goal of pkg.goals) {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO goals (hive_id, title, description, priority, status, budget_cents, spent_cents)
        VALUES (
          ${hive.id}::uuid,
          ${goal.title},
          ${goal.description},
          ${goal.priority},
          ${goal.status},
          ${goal.budgetCents},
          0
        )
        RETURNING id
      `;
      goalIdsByRef.set(goal.ref, row.id);
    }
    for (const task of pkg.tasks) {
      await tx`
        INSERT INTO tasks (
          hive_id, assigned_to, created_by, status, priority, budget_cents, spent_cents,
          title, brief, goal_id, qa_required, acceptance_criteria
        )
        VALUES (
          ${hive.id}::uuid,
          ${task.assignedTo},
          ${task.createdBy || "portability-import"},
          'pending',
          ${task.priority},
          ${task.budgetCents},
          0,
          ${task.title},
          ${task.brief},
          ${task.goalRef ? goalIdsByRef.get(task.goalRef) ?? null : null},
          ${task.qaRequired},
          ${task.acceptanceCriteria}
        )
      `;
    }

    return { hive, preview };
  });
}

async function loadPortableConnectors(sql: Sql, hiveId: string): Promise<HivePortablePackage["connectors"]> {
  const rows = await sql<{
    connector_slug: string;
    display_name: string;
    config: Record<string, unknown> | null;
    granted_scopes: string[] | null;
    status: string;
  }[]>`
    SELECT connector_slug, display_name, config, granted_scopes, status
    FROM connector_installs
    WHERE hive_id = ${hiveId}::uuid
      AND status IN ('active', 'disabled')
    ORDER BY connector_slug ASC, display_name ASC
  `;

  return rows.map((row) => {
    const definition = getConnectorDefinition(row.connector_slug);
    const secretFields = new Set<string>(definition?.secretFields ?? []);
    const config = scrubConnectorConfig(row.config ?? {}, secretFields);
    const envInputs = Array.from(secretFields).sort().map((field) => {
      const setupField = definition?.setupFields.find((candidate) => candidate.key === field);
      return {
        key: envInputKey(row.connector_slug, field),
        field,
        label: setupField?.label ?? field,
        required: setupField?.required ?? true,
        secret: true,
      };
    });
    return {
      connectorSlug: row.connector_slug,
      displayName: row.display_name,
      config,
      grantedScopes: Array.from(row.granted_scopes ?? []).sort(),
      status: row.status === "disabled" ? "disabled" : "active",
      credentialId: null,
      envInputs,
    };
  });
}

async function loadPortablePolicies(sql: Sql, hiveId: string): Promise<HivePortablePackage["policies"]> {
  const rows = await sql<{
    name: string;
    enabled: boolean;
    connector: string | null;
    operation: string | null;
    effect_type: string | null;
    effect: "allow" | "require_approval" | "block";
    role_slug: string | null;
    priority: number;
    conditions: Record<string, unknown> | null;
    reason: string | null;
    description: string | null;
  }[]>`
    SELECT name, enabled, connector, operation, effect_type, effect, role_slug, priority, conditions, reason, description
    FROM action_policies
    WHERE hive_id = ${hiveId}::uuid
      AND (
        effect IN ('require_approval', 'block')
        OR effect_type IN ('read', 'notify')
        OR effect_type IS NULL
      )
    ORDER BY priority DESC, name ASC, connector ASC NULLS LAST, operation ASC NULLS LAST
  `;
  return rows.map((row) => ({
    name: row.name,
    enabled: row.enabled,
    connector: row.connector,
    operation: row.operation,
    effectType: row.effect_type,
    effect: row.effect,
    roleSlug: row.role_slug,
    priority: row.priority,
    conditions: stableRecord(row.conditions ?? {}),
    reason: row.reason,
    description: row.description,
  }));
}

async function loadPortableSchedules(sql: Sql, hiveId: string): Promise<HivePortablePackage["schedules"]> {
  const rows = await sql<{
    cron_expression: string;
    task_template: Record<string, unknown> | string;
    enabled: boolean;
    origin_type: string;
    origin_key: string | null;
    created_by: string;
  }[]>`
    SELECT cron_expression, task_template, enabled, origin_type, origin_key, created_by
    FROM schedules
    WHERE hive_id = ${hiveId}::uuid
    ORDER BY origin_type ASC, origin_key ASC NULLS LAST, cron_expression ASC
  `;
  return rows.map((row) => ({
    cronExpression: row.cron_expression,
    taskTemplate: stableRecord(parseJsonObject(row.task_template)),
    enabled: row.enabled,
    originType: row.origin_type ?? "custom",
    originKey: row.origin_key,
    createdBy: row.created_by || "portability-import",
  }));
}

async function loadPortableGoals(sql: Sql, hiveId: string): Promise<HivePortablePackage["goals"]> {
  const rows = await sql<{
    id: string;
    title: string;
    description: string | null;
    priority: number;
    status: string;
    budget_cents: number | null;
  }[]>`
    SELECT id, title, description, priority, status, budget_cents
    FROM goals
    WHERE hive_id = ${hiveId}::uuid
      AND archived_at IS NULL
      AND status IN ('active', 'pending')
    ORDER BY priority ASC, title ASC, id ASC
  `;
  return rows
    .filter((row) => PORTABLE_GOAL_STATUSES.has(row.status))
    .map((row) => ({
      ref: `goal:${row.id}`,
      title: row.title,
      description: row.description,
      priority: row.priority,
      status: row.status as "active" | "pending",
      budgetCents: row.budget_cents,
    }));
}

async function loadPortableTasks(sql: Sql, hiveId: string): Promise<HivePortablePackage["tasks"]> {
  const rows = await sql<{
    title: string;
    brief: string;
    assigned_to: string;
    created_by: string;
    priority: number;
    budget_cents: number | null;
    qa_required: boolean;
    acceptance_criteria: string | null;
    goal_id: string | null;
  }[]>`
    SELECT title, brief, assigned_to, created_by, priority, budget_cents, qa_required, acceptance_criteria, goal_id
    FROM tasks
    WHERE hive_id = ${hiveId}::uuid
      AND status = 'pending'
      AND started_at IS NULL
      AND completed_at IS NULL
      AND spent_cents = 0
    ORDER BY priority ASC, title ASC, created_at ASC
  `;
  return rows.map((row) => ({
    title: row.title,
    brief: row.brief,
    assignedTo: row.assigned_to,
    createdBy: row.created_by,
    status: "pending",
    priority: row.priority,
    budgetCents: row.budget_cents,
    qaRequired: row.qa_required,
    acceptanceCriteria: row.acceptance_criteria,
    goalRef: row.goal_id ? `goal:${row.goal_id}` : null,
  }));
}

async function loadPortableRoles(sql: Sql, roleSlugs: Set<string>): Promise<HivePortableRole[]> {
  const useAllActiveRoles = roleSlugs.size === 0;
  const rows = useAllActiveRoles
    ? await sql<RoleTemplateRow[]>`
        SELECT slug, name, department, type, delegates_to, recommended_model, fallback_model,
               adapter_type, fallback_adapter_type, skills, tools_config, role_md, soul_md, tools_md,
               terminal, concurrency_limit
        FROM role_templates
        WHERE active = true
          AND type IN ('system', 'executor')
        ORDER BY slug ASC
      `
    : await sql<RoleTemplateRow[]>`
        SELECT slug, name, department, type, delegates_to, recommended_model, fallback_model,
               adapter_type, fallback_adapter_type, skills, tools_config, role_md, soul_md, tools_md,
               terminal, concurrency_limit
        FROM role_templates
        WHERE active = true
          AND slug IN ${sql(Array.from(roleSlugs).sort())}
        ORDER BY slug ASC
      `;
  return rows.map(mapRole);
}

type RoleTemplateRow = {
  slug: string;
  name: string;
  department: string | null;
  type: string;
  delegates_to: string[] | null;
  recommended_model: string | null;
  fallback_model: string | null;
  adapter_type: string;
  fallback_adapter_type: string | null;
  skills: string[] | null;
  tools_config: Record<string, unknown> | null;
  role_md: string | null;
  soul_md: string | null;
  tools_md: string | null;
  terminal: boolean;
  concurrency_limit: number;
};

function mapRole(row: RoleTemplateRow): HivePortableRole {
  return {
    slug: row.slug,
    name: row.name,
    department: row.department,
    type: row.type,
    delegatesTo: Array.from(row.delegates_to ?? []).sort(),
    recommendedModel: row.recommended_model,
    fallbackModel: row.fallback_model,
    adapterType: row.adapter_type,
    fallbackAdapterType: row.fallback_adapter_type,
    skills: Array.from(row.skills ?? []).sort(),
    toolsConfig: row.tools_config ? stableRecord(row.tools_config) : null,
    roleMd: row.role_md,
    soulMd: row.soul_md,
    toolsMd: row.tools_md,
    terminal: row.terminal,
    concurrencyLimit: row.concurrency_limit,
  };
}

function collectRoleSlugs(pkg: Pick<HivePortablePackage, "policies" | "schedules" | "tasks">): Set<string> {
  const slugs = new Set<string>();
  for (const policy of pkg.policies) if (policy.roleSlug) slugs.add(policy.roleSlug);
  for (const schedule of pkg.schedules) {
    const assignedTo = schedule.taskTemplate.assignedTo;
    if (typeof assignedTo === "string" && assignedTo.trim()) slugs.add(assignedTo);
  }
  for (const task of pkg.tasks) slugs.add(task.assignedTo);
  return slugs;
}

function insertConnector(
  tx: SqlExecutor,
  hiveId: string,
  connector: HivePortablePackage["connectors"][number],
) {
  const secretFields = new Set(connector.envInputs.map((input) => input.field));
  const config = scrubConnectorConfig(connector.config, secretFields);
  return tx`
    INSERT INTO connector_installs (hive_id, connector_slug, display_name, config, granted_scopes, credential_id, status)
    VALUES (
      ${hiveId}::uuid,
      ${connector.connectorSlug},
      ${connector.displayName},
      ${tx.json(config as never)},
      ${tx.json(Array.from(connector.grantedScopes).sort() as never)},
      null,
      ${connector.status}
    )
  `;
}

function scrubConnectorConfig(config: Record<string, unknown>, secretFields: Set<string>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(config).sort()) {
    if (!secretFields.has(key)) clean[key] = stableValue(config[key]);
  }
  return clean;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return parseJsonObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stablePackage(pkg: HivePortablePackage): HivePortablePackage {
  return JSON.parse(JSON.stringify(pkg)) as HivePortablePackage;
}

function stableRecord(record: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = stableValue(record[key]);
  return sorted;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return stableRecord(value as Record<string, unknown>);
  return value;
}

function envInputKey(connectorSlug: string, field: string): string {
  return `${connectorSlug}_${field}`
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function assertSupportedPackage(pkg: HivePortablePackage): void {
  if (
    !pkg
    || pkg.manifest?.kind !== HIVE_PORTABILITY_KIND
    || pkg.manifest?.version !== HIVE_PORTABILITY_VERSION
    || !pkg.hive
    || !Array.isArray(pkg.connectors)
    || !Array.isArray(pkg.roles)
  ) {
    throw new Error("Unsupported hive package");
  }
}

function normalizeSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  if (!HIVE_SLUG_REGEX.test(normalized)) throw new Error("Target hive slug is invalid");
  return normalized;
}

function buildWarnings(pkg: HivePortablePackage): string[] {
  const warnings = [
    "Runtime state is intentionally omitted: decisions, execution runs, audit events, credentials, memory embeddings, and work products.",
  ];
  if (pkg.connectors.length > 0) {
    warnings.push("Connector credentials are not imported; provide env inputs and reconnect credentials after import.");
  }
  return warnings;
}
