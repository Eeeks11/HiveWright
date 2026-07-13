import type { Sql, TransactionSql } from "postgres";

export interface OwnerHandoffSignal {
  needsOwner: boolean;
  title: string;
  context: string;
  recommendation: string;
  options: Array<{ key: string; label: string; consequence: string; response: string }>;
  rawContext: string;
  inputType: "missing_info" | "choose_option" | "approve_action" | "strategic_direction" | "risk_acceptance" | "other";
}

export interface EnsureOwnerHandoffDecisionInput {
  hiveId: string;
  goalId?: string | null;
  taskId: string;
  taskTitle: string;
  deliverable: string;
  notify?: boolean;
}

const OWNER_HANDOFF_PATTERNS = [
  /owner\s+decisions?\s+(?:still\s+)?required/i,
  /blockers?\s*\/\s*owner\s+decisions?/i,
  /owner\s+response\s+status\s+recorded\s+as\s+`?NO_RESPONSE_RECORDED`?/i,
  /trent\s+(?:still\s+)?needs\s+to\s+(?:choose|confirm|supply|provide|complete|decide|approve|select)/i,
  /trent\s+must\s+(?:choose|confirm|supply|provide|complete|decide|approve|select)/i,
  /formal\s+decision\s+required/i,
  /separate\s+owner\s+approval\s+is\s+still\s+required/i,
  /needs?\s+(?:owner|trent)\s+(?:input|decision|selection|approval|information)/i,
];

const PATH_OPTIONS = [
  {
    key: "generic_education_only",
    label: "Keep it general",
    consequence: "The hive can continue with education-only material, but it will not produce personalised portfolio advice.",
    response: "Keep this goal constrained to model-only/general education. Do not attempt personalised portfolio construction.",
  },
  {
    key: "supply_data_for_gate_rerun",
    label: "I’ll provide the missing data",
    consequence: "The hive will wait for the requested owner/profile facts and rerun the readiness check later.",
    response: "I will provide the requested profile facts and candidate-stack evidence so the hive can rerun the data-readiness gate.",
  },
  {
    key: "licensed_advice_review",
    label: "Use a licensed adviser",
    consequence: "The hive will treat personalised financial/tax advice as out of scope until a licensed adviser reviews it.",
    response: "Treat this as requiring licensed financial/tax advice review before any personalised recommendation or implementation step.",
  },
];

function compactText(text: string, max = 2_000): string {
  return text
    .replace(/```[\s\S]*?```/g, "[technical block hidden]")
    .replace(/`([^`]{1,80})`/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max)
    .trim();
}

function extractOwnerContext(deliverable: string): string {
  const normalized = compactText(deliverable, 4_000);
  const marker = normalized.search(/(?:blockers?\s*\/\s*)?owner\s+decisions?(?:\s+still)?\s+required|owner\s+response\s+status|trent\s+(?:still\s+)?needs\s+to\s+(?:choose|confirm|supply|provide|complete|decide|approve|select)/i);
  if (marker >= 0) {
    return normalized.slice(marker).slice(0, 2_000).trim();
  }
  return normalized.slice(0, 2_000).trim();
}

function hasPathChoice(deliverable: string): boolean {
  return /generic\s+education\s+only/i.test(deliverable)
    && /supply\s+data|candidate-stack\s+evidence|gate\s+rerun/i.test(deliverable)
    && /licensed\s+(?:financial[-\s]?advice|advice)|financial[-\s]?advice\s+review/i.test(deliverable);
}

function classifyInputType(deliverable: string): OwnerHandoffSignal["inputType"] {
  if (/choose|select|which\s+(?:path|option|approach)|one\s+path/i.test(deliverable)) return "choose_option";
  if (/approve|approval|sign[-\s]?off|authori[sz]/i.test(deliverable)) return "approve_action";
  if (/risk|liability|licensed|financial[-\s]?advice|tax|legal/i.test(deliverable)) return "risk_acceptance";
  if (/strategy|strategic|direction|positioning|scope/i.test(deliverable)) return "strategic_direction";
  if (/supply|provide|missing|need.*(?:info|data|detail|context)/i.test(deliverable)) return "missing_info";
  return "other";
}

function buildPlainEnglishSignal(deliverable: string, taskTitle: string): OwnerHandoffSignal {
  const rawContext = extractOwnerContext(deliverable);
  const inputType = classifyInputType(deliverable);

  if (hasPathChoice(deliverable)) {
    return {
      needsOwner: true,
      inputType: "choose_option",
      title: "Choose how the investing hive should proceed",
      context: [
        "The investing hive cannot continue safely until you choose the boundary for this work.",
        "It is trying to avoid turning a general research task into personalised financial advice without your explicit direction.",
      ].join("\n\n"),
      recommendation: "If you want the hive to keep moving without compliance risk, choose “Keep it general”. If you want personalised portfolio work, use the licensed-advice path.",
      options: PATH_OPTIONS,
      rawContext,
    };
  }

  const ask = rawContext
    .replace(/^[-*\s]*(?:blockers?\s*\/\s*)?owner\s+decisions?(?:\s+still)?\s+required[:\s-]*/i, "")
    .replace(/^[-*\s]*owner\s+response\s+status\s+recorded\s+as\s+NO_RESPONSE_RECORDED[.\s-]*/i, "")
    .trim();

  return {
    needsOwner: true,
    inputType,
    title: `Hive needs your input: ${taskTitle}`.slice(0, 500),
    context: ask
      ? `The hive needs a clear owner response before it can continue.\n\n${ask}`
      : "The hive needs a clear owner response before it can continue. The EA should review the raw request and either answer it or rewrite it for you.",
    recommendation: "The EA should answer this itself if it is covered by known owner preferences. Otherwise, it should put a short plain-English question to the owner.",
    options: [],
    rawContext,
  };
}

export function detectOwnerHandoffSignal(deliverable: string, taskTitle = "this task"): OwnerHandoffSignal | null {
  if (!deliverable?.trim()) return null;
  const needsOwner = OWNER_HANDOFF_PATTERNS.some((pattern) => pattern.test(deliverable));
  if (!needsOwner) return null;
  return buildPlainEnglishSignal(deliverable, taskTitle);
}

export async function ensureOwnerHandoffDecision(
  sql: Sql | TransactionSql,
  input: EnsureOwnerHandoffDecisionInput,
): Promise<{ created: boolean; decisionId?: string; reason?: string }> {
  const signal = detectOwnerHandoffSignal(input.deliverable, input.taskTitle);
  if (!signal) return { created: false, reason: "no_owner_handoff_signal" };

  const [existing] = await sql<{ id: string; status: string }[]>`
    SELECT id, status
    FROM decisions
    WHERE task_id = ${input.taskId}::uuid
      AND kind = 'decision'
      AND status IN ('pending', 'ea_review')
      AND COALESCE(route_metadata->>'source', '') = 'owner_handoff'
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (existing) return { created: false, decisionId: existing.id, reason: `existing_${existing.status}` };

  // Owner handoffs are intentionally EA-first. The owner should not see raw
  // hive/agent jargon. The EA may answer low-risk/context-obvious asks itself;
  // otherwise it rewrites this into a clean pending owner decision and notifies.
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO decisions (
      hive_id, goal_id, task_id, title, context, recommendation, options,
      priority, status, kind, route_metadata, ea_reasoning
    )
    VALUES (
      ${input.hiveId}::uuid,
      ${input.goalId ?? null},
      ${input.taskId}::uuid,
      ${signal.title},
      ${signal.context},
      ${signal.recommendation},
      ${sql.json(signal.options)},
      'normal',
      'ea_review',
      'decision',
      ${sql.json({
        source: "owner_handoff",
        taskId: input.taskId,
        autoDetected: true,
        inputType: signal.inputType,
        rawHiveRequest: signal.rawContext,
      })},
      ${`Raw hive request preserved for EA review: ${signal.rawContext}`}
    )
    RETURNING id
  `;

  await sql`
    INSERT INTO decision_messages (decision_id, sender, content)
    VALUES (
      ${row.id}::uuid,
      'system',
      ${`Hive requested owner input. EA review is required before this becomes owner-visible. Type: ${signal.inputType}.`}
    )
  `;

  return { created: true, decisionId: row.id };
}
