import type { Sql } from "postgres";
import { loadCredentials } from "@/credentials/manager";
import { buildAgentEnvironment } from "@/security/agent-environment";
import { buildAgentEnvironmentLifecycleConfig, checkAgentEnvironmentDiskPressure, cleanupAgentEnvironmentScopeByName } from "@/security/agent-environment-lifecycle";

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


export async function checkGoalSupervisorDiskGate(): Promise<{ allowed: boolean; reason: string }> {
  return checkAgentEnvironmentDiskPressure({
    config: buildAgentEnvironmentLifecycleConfig(),
  }).catch((err) => ({
    allowed: false,
    reason: `disk_pressure_check_failed: ${err instanceof Error ? err.message : String(err)}`,
  }));
}

export async function cleanupGoalSupervisorEnvironmentBestEffort(input: { adapter: GoalSupervisorAdapter; goalId: string; reason?: string }): Promise<void> {
  await cleanupAgentEnvironmentScopeByName({
    scopeName: `goal-${safeSegment(input.goalId)}--${safeSegment(input.adapter)}`,
    reason: input.reason ?? "goal_supervisor_terminal",
    proof: "goal supervisor process returned",
  }).catch((err) => {
    console.warn(`[agent-environment] goal supervisor cleanup skipped for ${input.goalId}/${input.adapter}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return (safe || "unknown").slice(0, 160);
}
