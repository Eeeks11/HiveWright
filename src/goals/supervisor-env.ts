import type { Sql } from "postgres";
import { loadCredentials } from "@/credentials/manager";
import { buildAgentEnvironment } from "@/security/agent-environment";

export type GoalSupervisorAdapter = "codex" | "openclaw";

export interface GoalSupervisorEnvironmentInput {
  adapter: GoalSupervisorAdapter;
  credentials?: Record<string, string | undefined>;
  goalId: string;
  hiveId: string;
  runtimeRoot?: string;
  supervisorSession: string;
}

export function buildGoalSupervisorProcessEnv(input: GoalSupervisorEnvironmentInput): NodeJS.ProcessEnv {
  return buildAgentEnvironment({
    scope: {
      kind: "goal-supervisor",
      adapter: input.adapter,
      goalId: input.goalId,
      hiveId: input.hiveId,
      supervisorSession: input.supervisorSession,
    },
    credentials: input.credentials,
    runtimeRoot: input.runtimeRoot,
    nativeProviderState: input.adapter === "codex"
      ? [".codex"]
      : [".openclaw", ".codex", ".claude", ".claude.json", ".gemini"],
  });
}

/** Load the one legacy supervisor bearer through the existing hive/role gate. */
export async function loadGoalSupervisorCredentials(
  sql: Sql,
  input: { goalId: string; hiveId: string },
): Promise<Record<string, string>> {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) return {};
  return loadCredentials(sql, {
    hiveId: input.hiveId,
    roleSlug: "goal-supervisor",
    requiredKeys: ["INTERNAL_SERVICE_TOKEN"],
    encryptionKey,
    auditContext: {
      actor: { type: "agent", id: "goal-supervisor" },
      hiveId: input.hiveId,
      goalId: input.goalId,
      agentId: `goal-supervisor:${input.goalId}`,
    },
  });
}
