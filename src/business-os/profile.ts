import type { JSONValue, Sql, TransactionSql } from "postgres";

export const BUSINESS_MODES = ["new_business", "existing_business"] as const;

export type BusinessMode = typeof BUSINESS_MODES[number];

export type BusinessOsProfileInput = {
  mode?: BusinessMode | string | null;
  businessName?: string | null;
  industry?: string | null;
  stage?: string | null;
  summary?: string | null;
  ownerGoals?: unknown;
  constraints?: unknown;
  approvalPolicy?: unknown;
  aiSpendBudget?: unknown;
  autonomyPolicy?: unknown;
  sourceProfile?: unknown;
};

export type BusinessOsProfile = {
  id: string;
  hiveId: string;
  businessMode: BusinessMode;
  businessName: string;
  industry: string | null;
  stage: string | null;
  summary: string | null;
  ownerGoals: string[];
  constraints: string[];
  approvalPolicy: Record<string, unknown>;
  aiSpendBudget: Record<string, unknown>;
  autonomyPolicy: Record<string, unknown>;
  sourceProfile: Record<string, unknown>;
};

type SqlExecutor = Sql | TransactionSql;
type JsonSqlExecutor = SqlExecutor & { json: Sql["json"] };

type BusinessOsProfileRow = {
  id: string;
  hive_id: string;
  business_mode: string;
  business_name: string;
  industry: string | null;
  stage: string | null;
  summary: string | null;
  owner_goals: unknown;
  constraints: unknown;
  approval_policy: unknown;
  ai_spend_budget: unknown;
  autonomy_policy: unknown;
  source_profile: unknown;
};

const businessModeSet = new Set<string>(BUSINESS_MODES);

const DEFAULT_APPROVAL_POLICY = {
  defaultPreset: "owner_review_first",
  publicActions: "owner_approval_required",
  spendActions: "owner_approval_required",
  customerMessages: "owner_approval_required",
  systemChanges: "owner_approval_required",
  destructiveActions: "blocked",
};

const DEFAULT_AUTONOMY_POLICY = {
  posture: "supervised",
  externalActions: "owner_approval_required",
  publicOrSpendSensitiveActions: "owner_approval_required",
  reportOnlyCompletion: "disallowed",
};

export function isBusinessMode(value: unknown): value is BusinessMode {
  return typeof value === "string" && businessModeSet.has(value);
}

export function normalizeBusinessMode(value: unknown): BusinessMode {
  return isBusinessMode(value) ? value : "new_business";
}

function trimText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed || null;
}

function normalizeTextList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map(trimText).filter((item): item is string => Boolean(item))));
  }
  const single = trimText(value);
  return single ? [single] : [];
}

function normalizeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JSONValue;
}

function rowToProfile(row: BusinessOsProfileRow): BusinessOsProfile {
  return {
    id: row.id,
    hiveId: row.hive_id,
    businessMode: normalizeBusinessMode(row.business_mode),
    businessName: row.business_name,
    industry: row.industry,
    stage: row.stage,
    summary: row.summary,
    ownerGoals: normalizeTextList(row.owner_goals),
    constraints: normalizeTextList(row.constraints),
    approvalPolicy: normalizeObject(row.approval_policy),
    aiSpendBudget: normalizeObject(row.ai_spend_budget),
    autonomyPolicy: normalizeObject(row.autonomy_policy),
    sourceProfile: normalizeObject(row.source_profile),
  };
}

export function businessOsKindProfile(profile: BusinessOsProfile): Record<string, unknown> {
  return {
    businessMode: profile.businessMode,
    businessName: profile.businessName,
    businessOs: {
      industry: profile.industry,
      stage: profile.stage,
      summary: profile.summary,
      ownerGoals: profile.ownerGoals,
      constraints: profile.constraints,
      approvalPolicy: profile.approvalPolicy,
      aiSpendBudget: profile.aiSpendBudget,
      autonomyPolicy: profile.autonomyPolicy,
    },
  };
}

export async function getBusinessOsProfile(sql: SqlExecutor, hiveId: string): Promise<BusinessOsProfile | null> {
  const [row] = await sql<BusinessOsProfileRow[]>`
    SELECT
      id,
      hive_id,
      business_mode,
      business_name,
      industry,
      stage,
      summary,
      owner_goals,
      constraints,
      approval_policy,
      ai_spend_budget,
      autonomy_policy,
      source_profile
    FROM business_os_profiles
    WHERE hive_id = ${hiveId}::uuid
    LIMIT 1
  `;
  return row ? rowToProfile(row) : null;
}

export async function upsertBusinessOsProfile(
  sql: JsonSqlExecutor,
  hiveId: string,
  input: BusinessOsProfileInput = {},
): Promise<BusinessOsProfile> {
  const [hive] = await sql<{ name: string; kind: string | null }[]>`
    SELECT name, kind FROM hives WHERE id = ${hiveId}::uuid LIMIT 1
  `;
  if (!hive) {
    throw new Error("hive not found");
  }
  if (hive.kind !== "business") {
    throw new Error("Business OS profiles can only be attached to business hives.");
  }

  const businessMode = normalizeBusinessMode(input.mode);
  const businessName = trimText(input.businessName) ?? hive.name;
  const approvalPolicy = {
    ...DEFAULT_APPROVAL_POLICY,
    ...normalizeObject(input.approvalPolicy),
  };
  const autonomyPolicy = {
    ...DEFAULT_AUTONOMY_POLICY,
    ...normalizeObject(input.autonomyPolicy),
  };

  const [row] = await sql<BusinessOsProfileRow[]>`
    INSERT INTO business_os_profiles (
      hive_id,
      business_mode,
      business_name,
      industry,
      stage,
      summary,
      owner_goals,
      constraints,
      approval_policy,
      ai_spend_budget,
      autonomy_policy,
      source_profile
    ) VALUES (
      ${hiveId}::uuid,
      ${businessMode},
      ${businessName},
      ${trimText(input.industry)},
      ${trimText(input.stage)},
      ${trimText(input.summary)},
      ${sql.json(toJsonValue(normalizeTextList(input.ownerGoals)))},
      ${sql.json(toJsonValue(normalizeTextList(input.constraints)))},
      ${sql.json(toJsonValue(approvalPolicy))},
      ${sql.json(toJsonValue(normalizeObject(input.aiSpendBudget)))},
      ${sql.json(toJsonValue(autonomyPolicy))},
      ${sql.json(toJsonValue(normalizeObject(input.sourceProfile)))}
    )
    ON CONFLICT (hive_id) DO UPDATE SET
      business_mode = EXCLUDED.business_mode,
      business_name = EXCLUDED.business_name,
      industry = EXCLUDED.industry,
      stage = EXCLUDED.stage,
      summary = EXCLUDED.summary,
      owner_goals = EXCLUDED.owner_goals,
      constraints = EXCLUDED.constraints,
      approval_policy = EXCLUDED.approval_policy,
      ai_spend_budget = EXCLUDED.ai_spend_budget,
      autonomy_policy = EXCLUDED.autonomy_policy,
      source_profile = EXCLUDED.source_profile,
      updated_at = NOW()
    RETURNING
      id,
      hive_id,
      business_mode,
      business_name,
      industry,
      stage,
      summary,
      owner_goals,
      constraints,
      approval_policy,
      ai_spend_budget,
      autonomy_policy,
      source_profile
  `;

  return rowToProfile(row);
}
