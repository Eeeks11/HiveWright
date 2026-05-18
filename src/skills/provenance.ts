import { AsyncLocalStorage } from "node:async_hooks";

export type SkillWriteOrigin = "user" | "agent" | "background_review" | "system";

const AGENT_CREATED_ORIGINS = new Set<SkillWriteOrigin>(["agent", "background_review"]);
const writeOrigin = new AsyncLocalStorage<SkillWriteOrigin>();

export function normalizeSkillWriteOrigin(origin: string | null | undefined): SkillWriteOrigin {
  switch (origin) {
    case "agent":
    case "background_review":
    case "system":
    case "user":
      return origin;
    default:
      return "user";
  }
}

export function getCurrentSkillWriteOrigin(): SkillWriteOrigin {
  return writeOrigin.getStore() ?? "user";
}

export function isAgentCreatedSkill(createdBy: string | null | undefined): boolean {
  return AGENT_CREATED_ORIGINS.has(normalizeSkillWriteOrigin(createdBy));
}

export function withSkillWriteOrigin<T>(origin: SkillWriteOrigin, fn: () => T): T {
  return writeOrigin.run(origin, fn);
}

export async function withAsyncSkillWriteOrigin<T>(origin: SkillWriteOrigin, fn: () => Promise<T>): Promise<T> {
  return writeOrigin.run(origin, fn);
}
