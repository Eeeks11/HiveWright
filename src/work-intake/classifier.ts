import type { ChatProvider } from "@/llm/types";
import type { ClassifierAttempt, ClassifierOutcome, ClassifierResult } from "./types";
import { buildClassifierPrompt, buildClassifierUserMessage } from "./prompt";
import { extractFirstJsonBlock, isValidClassifierResult } from "./type-guard";

export interface ClassifyDeps {
  primary: ChatProvider | null;
  fallback: ChatProvider | null;
  primaryModel: string;
  fallbackModel: string;
  confidenceThreshold: number;
  timeoutMs: number;
  temperature: number;
  maxTokens: number;
  validRoles: string[];
  roleLines: string[];
}

export async function classifyWork(input: string, deps: ClassifyDeps): Promise<ClassifierOutcome> {
  const heuristicResult = classifyVerificationOnlyTask(input, deps.validRoles);
  if (heuristicResult) {
    return {
      result: heuristicResult,
      attempts: [],
      usedFallback: false,
      providerUsed: "heuristic-verification",
      modelUsed: null,
    };
  }

  const { system } = buildClassifierPrompt(deps.roleLines);
  const user = buildClassifierUserMessage(input);

  const attempts: ClassifierAttempt[] = [];
  let fallbackTried = false;

  if (deps.primary) {
    const attempt = await tryProvider(
      deps.primary, deps.primaryModel, system, user, input,
      deps.timeoutMs, deps.temperature, deps.maxTokens,
      deps.confidenceThreshold, deps.validRoles,
    );
    attempts.push(attempt);
    if (attempt.success && attempt.parsedResult) {
      return {
        result: attempt.parsedResult,
        attempts,
        usedFallback: false,
        providerUsed: deps.primary.id === "ollama" ? "ollama" : "openrouter",
        modelUsed: attempt.model,
      };
    }
  }

  if (deps.fallback) {
    fallbackTried = true;
    const attempt = await tryProvider(
      deps.fallback, deps.fallbackModel, system, user, input,
      deps.timeoutMs, deps.temperature, deps.maxTokens,
      deps.confidenceThreshold, deps.validRoles,
    );
    attempts.push(attempt);
    if (attempt.success && attempt.parsedResult) {
      return {
        result: attempt.parsedResult,
        attempts,
        usedFallback: true,
        providerUsed: deps.fallback.id === "ollama" ? "ollama" : "openrouter",
        modelUsed: attempt.model,
      };
    }
  }

  return {
    result: null,
    attempts,
    usedFallback: fallbackTried,
    providerUsed: "default-goal-fallback",
    modelUsed: null,
  };
}

const VERIFICATION_INTENT_RE =
  /\b(verify|verification|verifying|confirm|confirmation|check|recheck|smoke test|re-verify|reverify|validate|validation|audit)\b/i;

const VERIFICATION_PROOF_ONLY_PATTERNS = [
  /\bdo not write code\b/i,
  /\bno code changes\b/i,
  /\bdo not modify any files\b/i,
  /\bdo not modify(?: application)? code\b/i,
  /\bdo not change(?: application)? code\b/i,
  /\bdo not commit\b/i,
  /\breport only\b/i,
  /\bproduce a concise\b/i,
  /\bproduce a concrete\b/i,
  /\bimplementation checklist\b/i,
  /\bimplementation-ready matrix\b/i,
  /\bfile-referenced list\b/i,
];

const VERIFICATION_IMPLEMENTATION_PATTERNS = [
  /\b(fix|implement|update|add|remove|commit|apply|write|create|delete|migrate|stage|edit|change|land|harden)\b/i,
  /\bif any remain\b/i,
  /\bif not committed\b/i,
  /\bif needed\b/i,
  /\bif unresolved\b/i,
  /\bapply the minimal fix\b/i,
  /\bmake only minimal follow-up edits\b/i,
  /\bupdate or add focused tests\b/i,
];

function classifyVerificationOnlyTask(
  input: string,
  validRoles: string[],
): ClassifierResult {
  const text = input.trim();
  if (!VERIFICATION_INTENT_RE.test(text)) return null;
  if (!VERIFICATION_PROOF_ONLY_PATTERNS.some((pattern) => pattern.test(text))) return null;
  if (VERIFICATION_IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(text))) return null;

  const role = chooseVerificationRole(text, validRoles);
  if (!role) return null;

  return {
    type: "task",
    role,
    confidence: 0.9,
    reasoning: verificationReasoning(role),
  };
}

function chooseVerificationRole(text: string, validRoles: string[]): string | null {
  const lower = text.toLowerCase();
  const rolePreferenceGroups = [
    {
      matches:
        /\b(auth|security|permission|permissions|vulnerability|vulnerabilities|coverage|mutation handler|access control)\b/i
          .test(lower),
      roles: ["security-auditor", "dev-agent"],
    },
    {
      matches:
        /\b(dispatcher|restart|runtime|incident|heartbeat|log|logs|outage|health|deploy|deployment)\b/i
          .test(lower),
      roles: ["system-health-auditor", "dev-agent"],
    },
    {
      matches: /\b(review|qa|checklist|report)\b/i.test(lower),
      roles: ["quality-reviewer", "operations-coordinator", "dev-agent"],
    },
  ];

  for (const group of rolePreferenceGroups) {
    if (!group.matches) continue;
    const matchedRole = group.roles.find((role) => validRoles.includes(role));
    if (matchedRole) return matchedRole;
  }

  return validRoles.includes("dev-agent")
    ? "dev-agent"
    : validRoles[0] ?? null;
}

function verificationReasoning(role: string): string {
  switch (role) {
    case "security-auditor":
      return "Proof-only verification/audit work is a single-session task; security/auth keywords route it to security-auditor.";
    case "system-health-auditor":
      return "Proof-only verification work is a single-session task; runtime/incident keywords route it to system-health-auditor.";
    case "quality-reviewer":
      return "Proof-only verification/review work is a single-session task; review/report wording routes it to quality-reviewer.";
    case "operations-coordinator":
      return "Proof-only verification/checklist work is a single-session task; operational review wording routes it to operations-coordinator.";
    default:
      return "Proof-only verification work is a single-session task, so it routes directly to an executor instead of decomposing into a goal.";
  }
}

interface ProviderAttempt extends ClassifierAttempt {
  parsedResult: ClassifierResult | null;
}

async function tryProvider(
  provider: ChatProvider,
  model: string,
  system: string,
  user: string,
  rawInput: string,
  timeoutMs: number,
  temperature: number,
  maxTokens: number,
  confidenceThreshold: number,
  validRoles: string[],
): Promise<ProviderAttempt> {
  const startedAt = Date.now();
  const base = {
    provider: provider.id,
    model,
    prompt: `${system}\n\n${user}`,
    input: rawInput,
    tokensIn: null as number | null,
    tokensOut: null as number | null,
    costCents: null as number | null,
  };

  try {
    const resp = await provider.chat({
      system, user, model, temperature, maxTokens, timeoutMs,
    });
    const latencyMs = Date.now() - startedAt;

    const jsonText = extractFirstJsonBlock(resp.text);
    if (!jsonText) {
      return {
        ...base,
        latencyMs,
        tokensIn: resp.tokensIn,
        tokensOut: resp.tokensOut,
        responseRaw: resp.text,
        success: false,
        errorReason: "no JSON object found in model response",
        parsedResult: null,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      return {
        ...base,
        latencyMs,
        tokensIn: resp.tokensIn,
        tokensOut: resp.tokensOut,
        responseRaw: resp.text,
        success: false,
        errorReason: `JSON parse failed: ${(err as Error).message}`,
        parsedResult: null,
      };
    }

    if (!isValidClassifierResult(parsed)) {
      return {
        ...base,
        latencyMs,
        tokensIn: resp.tokensIn,
        tokensOut: resp.tokensOut,
        responseRaw: resp.text,
        success: false,
        errorReason: "JSON did not match ClassifierResult schema",
        parsedResult: null,
      };
    }

    if (parsed.type === "task" && !validRoles.includes(parsed.role)) {
      return {
        ...base,
        latencyMs,
        tokensIn: resp.tokensIn,
        tokensOut: resp.tokensOut,
        responseRaw: resp.text,
        success: false,
        errorReason: `role '${parsed.role}' is not in the valid role library`,
        parsedResult: null,
      };
    }

    if (parsed.confidence < confidenceThreshold) {
      return {
        ...base,
        latencyMs,
        tokensIn: resp.tokensIn,
        tokensOut: resp.tokensOut,
        responseRaw: resp.text,
        success: false,
        errorReason: `confidence ${parsed.confidence} below threshold ${confidenceThreshold}`,
        parsedResult: null,
      };
    }

    return {
      ...base,
      latencyMs,
      tokensIn: resp.tokensIn,
      tokensOut: resp.tokensOut,
      responseRaw: resp.text,
      success: true,
      errorReason: null,
      parsedResult: parsed,
    };
  } catch (err) {
    return {
      ...base,
      latencyMs: Date.now() - startedAt,
      responseRaw: null,
      success: false,
      errorReason: (err as Error).message,
      parsedResult: null,
    };
  }
}
