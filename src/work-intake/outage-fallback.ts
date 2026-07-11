import type { ClassifierOutcome } from "./types";

const ACKNOWLEDGEMENT_INTENT = [
  /\backnowledg(?:e|ement)\b/i,
  /\bconfirm(?:ation of)? receipt\b/i,
  /\breceipt acknowledgement\b/i,
  /\breply (?:only )?(?:with )?["']?(?:received|acknowledged)["']?\b/i,
];

const RECEIPT_ONLY_CONSTRAINT = [
  /\b(?:only|just|solely|merely)\s+(?:acknowledge|confirm receipt)\b/i,
  /\b(?:acknowledgement|acknowledgment|receipt)(?:[- ]only| only)\b/i,
  /\bno (?:response|reply) beyond (?:an? )?(?:acknowledgement|acknowledgment|receipt confirmation)\b/i,
];

const NO_ACTION_CONSTRAINT = [
  /\b(?:take|perform|initiate) no (?:further )?action\b/i,
  /\bdo not (?:take|perform|initiate) (?:any |further )?action\b/i,
  /\bno (?:further )?(?:action|follow[- ]?up) (?:is )?(?:needed|required|permitted|authori[sz]ed)\b/i,
  /\bdo not (?:execute|change|modify|contact|send|purchase|order|book|schedule)\b/i,
];

const NO_SPEND_CONSTRAINT = [
  /\b(?:incur|make|authori[sz]e) no (?:costs?|spend(?:ing)?|expenditure|expense)\b/i,
  /\bdo not (?:spend|purchase|pay|incur|authori[sz]e (?:any )?(?:spend(?:ing)?|costs?|expenses?))\b/i,
  /\bno (?:spend(?:ing)?|expenditure|expense|costs?|financial commitment)\b/i,
  /\bzero[- ](?:spend|cost|budget)\b/i,
];

const SUBSTANTIVE_WORK =
  /\b(?:analy[sz]e|approve|build|change|contact|coordinate|create|draft|evaluate|execute|implement|investigate|modify|plan|prepare|purchase|research|review|schedule|send|update|write)\b/i;

function withoutMatchedConstraints(text: string): string {
  return [
    ...ACKNOWLEDGEMENT_INTENT,
    ...RECEIPT_ONLY_CONSTRAINT,
    ...NO_ACTION_CONSTRAINT,
    ...NO_SPEND_CONSTRAINT,
  ].reduce((remaining, pattern) => {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    return remaining.replace(new RegExp(pattern.source, flags), " ");
  }, text);
}

/**
 * Deterministic routing is deliberately narrower than ordinary intent
 * classification. It is used only when every classifier attempt failed, and
 * only when all four independently explicit constraints are present.
 */
export function isExplicitReceiptOnlyOutageFallback(input: string): boolean {
  const text = input.trim();
  if (!text) return false;
  return ACKNOWLEDGEMENT_INTENT.some((pattern) => pattern.test(text))
    && RECEIPT_ONLY_CONSTRAINT.some((pattern) => pattern.test(text))
    && NO_ACTION_CONSTRAINT.some((pattern) => pattern.test(text))
    && NO_SPEND_CONSTRAINT.some((pattern) => pattern.test(text))
    && !SUBSTANTIVE_WORK.test(withoutMatchedConstraints(text));
}

export function asOperationsReceiptTask(outcome: ClassifierOutcome): ClassifierOutcome {
  return {
    ...outcome,
    result: {
      type: "task",
      role: "operations-coordinator",
      confidence: 1,
      reasoning: "Deterministic outage fallback: the request explicitly limits work to receipt acknowledgement, with no action and no spend.",
    },
  };
}
