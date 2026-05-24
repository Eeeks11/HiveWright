import type { JSONValue, Sql, TransactionSql } from "postgres";
import { defaultInitialGoalForHiveKind, normalizeHiveKind, type HiveKind } from "@/hives/kind";
import type { SafetyPreset } from "@/hives/setup";

type SqlExecutor = Sql | TransactionSql;

type JsonSqlExecutor = SqlExecutor & {
  json: Sql["json"];
};

type HiveProfileSeed = {
  hiveId: string;
  name: string;
  kind: HiveKind | string | null;
  description?: string | null;
  mission?: string | null;
  initialGoal?: string | null;
  safetyPreset?: SafetyPreset;
};

export type OperatingProfileInput = Partial<{
  purpose: string | null;
  desiredOutcome: string | null;
  current30DayOutcome: string | null;
  constraints: unknown;
  approvalRules: unknown;
  forbiddenActions: unknown;
  importantContext: unknown;
  successCriteria: unknown;
  stopOrPauseCriteria: unknown;
  kindProfile: unknown;
}>;

export type OperatingProfile = {
  hiveId: string;
  kind: HiveKind;
  purpose: string;
  desiredOutcome: string;
  current30DayOutcome: string | null;
  constraints: string[];
  approvalRules: string[];
  forbiddenActions: string[];
  importantContext: string[];
  successCriteria: string[];
  stopOrPauseCriteria: string[];
  kindProfile: Record<string, unknown>;
  isDerived: boolean;
};

type HiveRow = {
  id: string;
  name: string;
  kind: string | null;
  description: string | null;
  mission: string | null;
};

type ProfileRow = {
  hive_id: string;
  kind: string;
  purpose: string;
  desired_outcome: string;
  current_30_day_outcome: string | null;
  constraints: unknown;
  approval_rules: unknown;
  forbidden_actions: unknown;
  important_context: unknown;
  success_criteria: unknown;
  stop_or_pause_criteria: unknown;
  kind_profile: unknown;
};

const MAX_PROMPT_ITEMS = 8;
const MAX_PROMPT_KIND_PROFILE_KEYS = 6;
const MAX_PROMPT_LINE_CHARS = 260;

const KIND_DOCTRINE: Record<HiveKind, string> = {
  business:
    "Think in business outcomes, revenue, customers, margins, fulfilment, and the path to profit. Prefer work that validates the offer, creates qualified demand, improves delivery, or clarifies owner decisions.",
  personal_project:
    "Think in milestones, deliverables, blockers, dependencies, and the next shippable artifact. Prefer concrete progress over broad exploration.",
  personal_assistant:
    "Treat external or sensitive actions as owner-approval-gated. Prepare drafts, reminders, research, and options, but do not send messages, spend money, book, cancel, share private data, or make commitments without approval.",
  research:
    "Think in research questions, source quality, confidence, unknowns, and recommendation readiness. Separate evidence from assumptions.",
  creative:
    "Think in audience, asset purpose, drafts, variants, review cycles, brand constraints, and publication readiness.",
};

const KIND_PROFILE_DEFAULTS: Record<HiveKind, Record<string, unknown>> = {
  business: {
    offer: "",
    targetCustomer: "",
    pricing: "",
    fulfilmentModel: "",
    channels: [],
  },
  personal_project: {
    milestones: ["Define deliverables", "Identify blockers", "Ship the next useful artifact"],
    resources: [],
    dependencies: [],
    dueDates: [],
  },
  personal_assistant: {
    recurringDuties: [],
    trustedSources: [],
    contactBoundaries: [],
    sensitiveActionBoundaries: [
      "External or sensitive actions require owner approval before execution.",
    ],
  },
  research: {
    researchQuestions: [],
    acceptableSources: [],
    confidenceBar: "State confidence and unknowns before recommending action.",
    outputFormat: "Recommendation with evidence and next steps.",
  },
  creative: {
    audience: "",
    style: "",
    brandRules: [],
    publishingPath: "",
  },
};

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

function normalizeKindProfile(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const cleanKey = trimText(key);
    if (!cleanKey) continue;
    if (Array.isArray(raw)) {
      const list = normalizeTextList(raw);
      if (list.length > 0) result[cleanKey] = list;
      continue;
    }
    if (raw && typeof raw === "object") {
      const nested = normalizeKindProfile(raw);
      if (Object.keys(nested).length > 0) result[cleanKey] = nested;
      continue;
    }
    const text = trimText(raw);
    if (text) result[cleanKey] = text;
  }
  return result;
}

function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JSONValue;
}

function mergeUnique(base: string[], extra: string[]): string[] {
  return Array.from(new Set([...base, ...extra].map(trimText).filter((item): item is string => Boolean(item))));
}

function withFallback(value: string | null | undefined, fallback: string): string {
  return trimText(value) ?? fallback;
}

function safetyApprovalRules(kind: HiveKind, safetyPreset: SafetyPreset = "owner_review_first"): string[] {
  if (safetyPreset === "open") {
    return ["Use owner-approved policies and connected-service permissions before taking external action."];
  }
  if (safetyPreset === "locked_down") {
    return [
      "Do not take external, financial, notification, system, or destructive actions until the owner explicitly enables them.",
    ];
  }
  if (kind === "personal_assistant") {
    return [
      "External or sensitive actions require owner approval before execution.",
      "Get owner approval before sending messages, booking, cancelling, spending money, sharing private data, or making commitments.",
    ];
  }
  if (kind === "personal_project") {
    return [
      "Get owner approval before committing spend, changing scope, or contacting external parties.",
    ];
  }
  return [
    "Owner approval required before publishing, spending money, or making external commitments.",
  ];
}

function defaultsForKind(kind: HiveKind) {
  switch (kind) {
    case "business":
      return {
        constraints: ["Protect owner time, cash, customer trust, and compliance boundaries."],
        successCriteria: ["Clear customer path", "Credible revenue or profit signal", "Owner-approved next commercial action"],
        stopOrPauseCriteria: ["Pause if work creates legal, financial, brand, or customer-trust risk without owner approval."],
      };
    case "personal_project":
      return {
        constraints: ["Prefer practical delivery steps over open-ended planning."],
        successCriteria: ["Milestone advanced", "Deliverable shipped or clarified", "Blocker removed or escalated"],
        stopOrPauseCriteria: ["Pause if scope, budget, deadline, or external commitments need owner decision."],
      };
    case "personal_assistant":
      return {
        constraints: ["Prepare work for owner review; do not act externally without approval."],
        successCriteria: ["Admin request prepared", "Owner decision made easier", "Sensitive action held for approval"],
        stopOrPauseCriteria: ["Pause before sending, booking, cancelling, spending, sharing private data, or changing accounts."],
      };
    case "research":
      return {
        constraints: ["Separate sourced evidence, assumptions, confidence, and unknowns."],
        successCriteria: ["Questions answered", "Sources assessed", "Recommendation and confidence stated"],
        stopOrPauseCriteria: ["Pause if evidence is too weak or the recommendation would trigger external action."],
      };
    case "creative":
      return {
        constraints: ["Respect brand, audience, review, and publishing boundaries."],
        successCriteria: ["Draft or asset produced", "Variant reviewed", "Publication path clarified"],
        stopOrPauseCriteria: ["Pause before public publishing or brand-sensitive changes without owner approval."],
      };
  }
}

export function deriveOperatingProfileDefaults(seed: HiveProfileSeed): OperatingProfile {
  const kind = normalizeHiveKind(seed.kind);
  const initialGoal = trimText(seed.initialGoal) ?? defaultInitialGoalForHiveKind(kind, seed.name);
  const mission = trimText(seed.mission);
  const description = trimText(seed.description);
  const kindDefaults = defaultsForKind(kind);

  return {
    hiveId: seed.hiveId,
    kind,
    purpose: mission ?? description ?? initialGoal,
    desiredOutcome: description ?? mission ?? initialGoal,
    current30DayOutcome: initialGoal,
    constraints: kindDefaults.constraints,
    approvalRules: safetyApprovalRules(kind, seed.safetyPreset),
    forbiddenActions: kind === "personal_assistant"
      ? ["Do not send messages, book, cancel, spend money, share private data, or make commitments without owner approval."]
      : ["Do not bypass owner-defined approval rules or connected-service governance."],
    importantContext: [],
    successCriteria: kindDefaults.successCriteria,
    stopOrPauseCriteria: kindDefaults.stopOrPauseCriteria,
    kindProfile: KIND_PROFILE_DEFAULTS[kind],
    isDerived: true,
  };
}

function normalizeProfile(
  hive: HiveRow,
  input: OperatingProfileInput,
  fallback?: OperatingProfile,
): OperatingProfile {
  const defaults = fallback ?? deriveOperatingProfileDefaults({
    hiveId: hive.id,
    name: hive.name,
    kind: hive.kind,
    description: hive.description,
    mission: hive.mission,
  });
  const kind = normalizeHiveKind(hive.kind);
  return {
    hiveId: hive.id,
    kind,
    purpose: withFallback(input.purpose, defaults.purpose),
    desiredOutcome: withFallback(input.desiredOutcome, defaults.desiredOutcome),
    current30DayOutcome: trimText(input.current30DayOutcome) ?? defaults.current30DayOutcome,
    constraints: mergeUnique([], normalizeTextList(input.constraints ?? defaults.constraints)),
    approvalRules: mergeUnique([], normalizeTextList(input.approvalRules ?? defaults.approvalRules)),
    forbiddenActions: mergeUnique([], normalizeTextList(input.forbiddenActions ?? defaults.forbiddenActions)),
    importantContext: mergeUnique([], normalizeTextList(input.importantContext ?? defaults.importantContext)),
    successCriteria: mergeUnique([], normalizeTextList(input.successCriteria ?? defaults.successCriteria)),
    stopOrPauseCriteria: mergeUnique([], normalizeTextList(input.stopOrPauseCriteria ?? defaults.stopOrPauseCriteria)),
    kindProfile: {
      ...normalizeKindProfile(defaults.kindProfile),
      ...normalizeKindProfile(input.kindProfile ?? defaults.kindProfile),
    },
    isDerived: false,
  };
}

function rowToProfile(row: ProfileRow): OperatingProfile {
  const kind = normalizeHiveKind(row.kind);
  return {
    hiveId: row.hive_id,
    kind,
    purpose: row.purpose,
    desiredOutcome: row.desired_outcome,
    current30DayOutcome: row.current_30_day_outcome,
    constraints: normalizeTextList(row.constraints),
    approvalRules: normalizeTextList(row.approval_rules),
    forbiddenActions: normalizeTextList(row.forbidden_actions),
    importantContext: normalizeTextList(row.important_context),
    successCriteria: normalizeTextList(row.success_criteria),
    stopOrPauseCriteria: normalizeTextList(row.stop_or_pause_criteria),
    kindProfile: {
      ...normalizeKindProfile(KIND_PROFILE_DEFAULTS[kind]),
      ...normalizeKindProfile(row.kind_profile),
    },
    isDerived: false,
  };
}

async function loadHive(sql: SqlExecutor, hiveId: string): Promise<HiveRow | null> {
  const [hive] = await sql<HiveRow[]>`
    SELECT id, name, kind, description, mission
    FROM hives
    WHERE id = ${hiveId}
  `;
  return hive ?? null;
}

export async function getOperatingProfile(sql: SqlExecutor, hiveId: string): Promise<OperatingProfile | null> {
  const hive = await loadHive(sql, hiveId);
  if (!hive) return null;

  const [row] = await sql<ProfileRow[]>`
    SELECT
      hive_id,
      kind,
      purpose,
      desired_outcome,
      current_30_day_outcome,
      constraints,
      approval_rules,
      forbidden_actions,
      important_context,
      success_criteria,
      stop_or_pause_criteria,
      kind_profile
    FROM hive_operating_profiles
    WHERE hive_id = ${hiveId}
    LIMIT 1
  `;
  if (row) return rowToProfile(row);
  return deriveOperatingProfileDefaults({
    hiveId,
    name: hive.name,
    kind: hive.kind,
    description: hive.description,
    mission: hive.mission,
  });
}

export async function upsertOperatingProfile(
  sql: JsonSqlExecutor,
  hiveId: string,
  input: OperatingProfileInput,
): Promise<OperatingProfile> {
  const hive = await loadHive(sql, hiveId);
  if (!hive) {
    throw new Error("hive not found");
  }
  const existing = await getOperatingProfile(sql, hiveId);
  const profile = normalizeProfile(hive, input, existing ?? undefined);

  const [row] = await sql<ProfileRow[]>`
    INSERT INTO hive_operating_profiles (
      hive_id,
      kind,
      purpose,
      desired_outcome,
      current_30_day_outcome,
      constraints,
      approval_rules,
      forbidden_actions,
      important_context,
      success_criteria,
      stop_or_pause_criteria,
      kind_profile
    )
    VALUES (
      ${hiveId},
      ${profile.kind},
      ${profile.purpose},
      ${profile.desiredOutcome},
      ${profile.current30DayOutcome},
      ${sql.json(profile.constraints)},
      ${sql.json(profile.approvalRules)},
      ${sql.json(profile.forbiddenActions)},
      ${sql.json(profile.importantContext)},
      ${sql.json(profile.successCriteria)},
      ${sql.json(profile.stopOrPauseCriteria)},
      ${sql.json(toJsonValue(profile.kindProfile))}
    )
    ON CONFLICT (hive_id) DO UPDATE SET
      kind = EXCLUDED.kind,
      purpose = EXCLUDED.purpose,
      desired_outcome = EXCLUDED.desired_outcome,
      current_30_day_outcome = EXCLUDED.current_30_day_outcome,
      constraints = EXCLUDED.constraints,
      approval_rules = EXCLUDED.approval_rules,
      forbidden_actions = EXCLUDED.forbidden_actions,
      important_context = EXCLUDED.important_context,
      success_criteria = EXCLUDED.success_criteria,
      stop_or_pause_criteria = EXCLUDED.stop_or_pause_criteria,
      kind_profile = EXCLUDED.kind_profile,
      updated_at = NOW()
    RETURNING
      hive_id,
      kind,
      purpose,
      desired_outcome,
      current_30_day_outcome,
      constraints,
      approval_rules,
      forbidden_actions,
      important_context,
      success_criteria,
      stop_or_pause_criteria,
      kind_profile
  `;

  return rowToProfile(row);
}

function capLine(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_PROMPT_LINE_CHARS) return normalized;
  return `${normalized.slice(0, MAX_PROMPT_LINE_CHARS).trimEnd()} … [truncated]`;
}

function pushList(lines: string[], label: string, items: string[]) {
  const capped = items.map(capLine).slice(0, MAX_PROMPT_ITEMS);
  if (capped.length === 0) return;
  lines.push(`${label}:`);
  for (const item of capped) {
    lines.push(`- ${item}`);
  }
}

function summarizeKindProfile(kindProfile: Record<string, unknown>): string[] {
  return Object.entries(kindProfile)
    .slice(0, MAX_PROMPT_KIND_PROFILE_KEYS)
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return `${key}: ${value.map(String).map(capLine).slice(0, 4).join("; ")}`;
      }
      if (value && typeof value === "object") {
        return `${key}: ${Object.keys(value).slice(0, 4).join(", ")}`;
      }
      return `${key}: ${capLine(String(value))}`;
    })
    .filter((line) => !line.endsWith(": "));
}

export function serializeOperatingProfileForPrompt(profile: OperatingProfile): string {
  const lines: string[] = [`**Operating Profile:** ${profile.kind}`];
  lines.push(`Purpose: ${capLine(profile.purpose)}`);
  lines.push(`Desired outcome: ${capLine(profile.desiredOutcome)}`);
  if (profile.current30DayOutcome) {
    lines.push(`Current 30-day outcome: ${capLine(profile.current30DayOutcome)}`);
  }
  pushList(lines, "Owner constraints", profile.constraints);
  pushList(lines, "Owner approval rules", profile.approvalRules);
  pushList(lines, "Forbidden actions", profile.forbiddenActions);
  pushList(lines, "Important context", profile.importantContext);
  pushList(lines, "Success criteria", profile.successCriteria);
  pushList(lines, "Stop or pause criteria", profile.stopOrPauseCriteria);
  pushList(lines, "Kind profile", summarizeKindProfile(profile.kindProfile));
  lines.push(`Kind doctrine: ${KIND_DOCTRINE[profile.kind]}`);
  return lines.join("\n");
}
