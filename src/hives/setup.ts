import fs from "node:fs";
import path from "node:path";
import type { Sql, TransactionSql } from "postgres";
import { getConnectorDefinition } from "@/connectors/registry";
import { invokeConnectorReadOnlyOrSystem } from "@/connectors/runtime";
import { storeCredential } from "@/credentials/manager";
import { isValidHiveAddress } from "@/hives/address";
import { defaultInitialGoalForHiveKind, isHiveKind, type HiveKind } from "@/hives/kind";
import { deriveOperatingProfileDefaults, upsertOperatingProfile } from "@/hives/operating-profile";
import { seedDefaultSchedules } from "@/hives/seed-schedules";
import { hiveProjectsPath, hiveRootPath, resolveHiveWorkspaceRoot } from "@/hives/workspace-root";
import { saveHiveRoleOverride } from "@/roles/hive-overrides";

const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type RoleOverride = {
  adapterType?: string;
  recommendedModel?: string;
};

export type ConnectorSetup = {
  connectorSlug: string;
  displayName: string;
  fields: Record<string, string>;
  grantedScopes?: string[];
};

export type InstalledConnectorSetupResult = {
  id: string;
  connectorSlug: string;
  displayName: string;
  requiresDispatcherRestart: boolean;
  hasSafeTest: boolean;
};

export type ProjectSetup = {
  name: string;
  slug: string;
  workspacePath?: string;
  gitRepo?: boolean;
};

export type OperatingPreferences = {
  maxConcurrentAgents?: number;
  proactiveWork?: boolean;
  memorySearch?: boolean;
  requestSorting?: "balanced" | "direct" | "goals";
};

export type SafetyPreset = "open" | "owner_review_first" | "locked_down" | "custom";

export type HiveSetupRequest = {
  hive?: {
    name?: string;
    slug?: string;
    type?: string;
    kind?: HiveKind | string;
    description?: string;
    mission?: string;
  };
  roleOverrides?: Record<string, RoleOverride>;
  connectors?: ConnectorSetup[];
  projects?: ProjectSetup[];
  initialGoal?: string;
  operatingPreferences?: OperatingPreferences;
  safetyPreset?: SafetyPreset;
};

export type HiveSetupStep =
  | "hive-record"
  | "role-overrides"
  | "action-policies"
  | "connectors"
  | "projects"
  | "initial-goal";

export class HiveSetupError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "HiveSetupError";
    this.status = status;
  }
}

type SqlExecutor = Sql | TransactionSql;

type RunHiveSetupOptions = {
  failAfterStep?: HiveSetupStep;
};

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function requireHiveProjectsRoot(hiveSlug: string): string {
  if (!PROJECT_SLUG_RE.test(hiveSlug)) {
    throw new HiveSetupError("We could not prepare the project folders for this hive.");
  }

  const hiveProjectsRoot = hiveProjectsPath(hiveSlug);
  const resolvedRoot = resolveHiveWorkspaceRoot();
  const resolvedHiveProjectsRoot = path.resolve(hiveProjectsRoot);
  if (!isPathInside(resolvedHiveProjectsRoot, resolvedRoot)) {
    throw new HiveSetupError("We could not prepare the project folders for this hive.");
  }

  return resolvedHiveProjectsRoot;
}

function requireContainedWorkspace(candidatePath: string, allowedRoot: string): string {
  const resolvedRoot = path.resolve(allowedRoot);
  const resolvedCandidate = path.resolve(candidatePath);
  if (!isPathInside(resolvedCandidate, resolvedRoot)) {
    throw new HiveSetupError("Project folders must stay inside this hive.");
  }
  return resolvedCandidate;
}

function recordDirectoryIfNew(createdDirectories: Set<string>, directoryPath: string) {
  if (fs.existsSync(directoryPath)) {
    return;
  }
  fs.mkdirSync(directoryPath, { recursive: true });
  createdDirectories.add(directoryPath);
}

function createHiveDirectories(slug: string, createdDirectories: Set<string>) {
  const hiveRoot = hiveRootPath(slug);
  const hiveRootWasMissing = !fs.existsSync(hiveRoot);

  for (const dir of ["projects", "skills", "ea"]) {
    recordDirectoryIfNew(createdDirectories, path.join(hiveRoot, dir));
  }

  if (hiveRootWasMissing && fs.existsSync(hiveRoot)) {
    createdDirectories.add(hiveRoot);
  }
}

function createProjectDirectory(workspacePath: string, createdDirectories: Set<string>) {
  recordDirectoryIfNew(createdDirectories, workspacePath);
}

function isGitRepository(workspacePath: string): boolean {
  return fs.existsSync(path.join(workspacePath, ".git"));
}

function cleanupDirectories(createdDirectories: Set<string>) {
  for (const directoryPath of [...createdDirectories].sort((a, b) => b.length - a.length)) {
    fs.rmSync(directoryPath, { recursive: true, force: true });
  }
}

function maybeFailSetup(step: HiveSetupStep, options: RunHiveSetupOptions | undefined) {
  if (options?.failAfterStep !== step) {
    return;
  }
  throw new Error(`Forced hive setup failure after ${step}.`);
}

export function plainSetupError(err: unknown): string {
  if (err instanceof HiveSetupError) {
    return err.message;
  }
  if (isUniqueHiveAddressError(err)) {
    return "That hive address is already in use. Please choose a different hive name or custom hive address.";
  }
  if (err instanceof Error && err.message) return err.message;
  return "Hive setup did not finish. Please try again.";
}

export function isUniqueHiveAddressError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

function normalizeOperatingPreferences(preferences: OperatingPreferences | undefined): Required<OperatingPreferences> {
  const maxConcurrentAgents = Number(preferences?.maxConcurrentAgents ?? 3);
  return {
    maxConcurrentAgents: Number.isInteger(maxConcurrentAgents) && maxConcurrentAgents >= 1 && maxConcurrentAgents <= 50
      ? maxConcurrentAgents
      : 3,
    proactiveWork: preferences?.proactiveWork ?? true,
    memorySearch: preferences?.memorySearch ?? true,
    requestSorting: preferences?.requestSorting === "direct" || preferences?.requestSorting === "goals"
      ? preferences.requestSorting
      : "balanced",
  };
}

function workIntakeConfigForPreset(preset: Required<OperatingPreferences>["requestSorting"]) {
  const base = {
    primaryProvider: "ollama",
    primaryModel: "qwen3:32b",
    fallbackProvider: "openrouter",
    fallbackModel: "google/gemini-2.5-flash",
    timeoutMs: 15000,
    temperature: 0.1,
    maxTokens: 512,
  };

  if (preset === "direct") {
    return { ...base, confidenceThreshold: 0.5, setupPreset: "direct" };
  }
  if (preset === "goals") {
    return { ...base, confidenceThreshold: 0.75, setupPreset: "goals" };
  }
  return { ...base, confidenceThreshold: 0.6, setupPreset: "balanced" };
}

async function saveAdapterConfig(
  tx: SqlExecutor,
  adapterType: string,
  config: Record<string, unknown>,
  hiveId: string | null = null,
) {
  const jsonConfig = config as Parameters<Sql["json"]>[0];
  const existing = hiveId === null
    ? await tx`SELECT id FROM adapter_config WHERE adapter_type = ${adapterType} AND hive_id IS NULL LIMIT 1`
    : await tx`SELECT id FROM adapter_config WHERE adapter_type = ${adapterType} AND hive_id = ${hiveId}::uuid LIMIT 1`;

  if (existing.length > 0) {
    await tx`UPDATE adapter_config SET config = ${tx.json(jsonConfig)}, updated_at = NOW() WHERE id = ${existing[0].id}`;
    return;
  }

  await tx`
    INSERT INTO adapter_config (hive_id, adapter_type, config)
    VALUES (${hiveId}, ${adapterType}, ${tx.json(jsonConfig)})
  `;
}

async function seedSafetyPolicies(tx: SqlExecutor, hiveId: string, preset: SafetyPreset = "owner_review_first") {
  const policies = preset === "open"
    ? [
      {
        name: "Allow read-only work",
        effectType: "read",
        effect: "allow",
        priority: 1000,
        reason: "Green preset: agents may inspect context and prepare work.",
      },
      {
        name: "Allow notifications",
        effectType: "notify",
        effect: "allow",
        priority: 990,
        reason: "Green preset: outbound messages and notifications are allowed for connected services.",
      },
      {
        name: "Allow external changes",
        effectType: "write",
        effect: "allow",
        priority: 980,
        reason: "Green preset: agents may make external changes through connected services.",
      },
      {
        name: "Allow financial actions",
        effectType: "financial",
        effect: "allow",
        priority: 970,
        reason: "Green preset: financial actions are allowed when the connected service permits them.",
      },
      {
        name: "Allow system changes",
        effectType: "system",
        effect: "allow",
        priority: 960,
        reason: "Green preset: configuration and system-level actions are allowed.",
      },
      {
        name: "Allow destructive actions",
        effectType: "destructive",
        effect: "allow",
        priority: 950,
        reason: "Green preset: deletes and irreversible actions are allowed without approval gates.",
      },
    ]
    : preset === "locked_down"
    ? [
      {
        name: "Allow read-only setup checks",
        effectType: "read",
        effect: "allow",
        priority: 1000,
        reason: "Locked down preset: agents may inspect context but cannot act externally.",
      },
      {
        name: "Block notifications",
        effectType: "notify",
        effect: "block",
        priority: 960,
        reason: "Locked down preset: outbound messages and notifications are blocked until explicitly enabled.",
      },
      {
        name: "Block external changes",
        effectType: "write",
        effect: "block",
        priority: 950,
        reason: "Locked down preset: owner approval is required before enabling external changes.",
      },
      {
        name: "Block financial actions",
        effectType: "financial",
        effect: "block",
        priority: 940,
        reason: "Locked down preset: financial actions are blocked until explicitly enabled.",
      },
      {
        name: "Block system changes",
        effectType: "system",
        effect: "block",
        priority: 930,
        reason: "Locked down preset: configuration and system-level changes are blocked until explicitly enabled.",
      },
      {
        name: "Block destructive actions",
        effectType: "destructive",
        effect: "block",
        priority: 920,
        reason: "Locked down preset: deletes and irreversible actions are blocked.",
      },
    ]
    : [
      {
        name: "Allow low-risk read-only work",
        effectType: "read",
        effect: "allow",
        priority: 1000,
        reason: "Owner review first preset: agents may read context and prepare useful work.",
      },
      {
        name: "Allow owner notification Discord webhook",
        connector: "discord-webhook",
        operation: "send_message",
        effectType: "notify",
        effect: "allow",
        priority: 1200,
        reason: "Owner review first preset: the system may notify the owner through the configured Discord webhook without creating a recursive approval loop.",
      },
      {
        name: "Allow owner notification Discord bot",
        connector: "ea-discord",
        operation: "send_channel",
        effectType: "notify",
        effect: "allow",
        priority: 1190,
        reason: "Owner review first preset: the system may notify the owner through the configured EA Discord channel without creating a recursive approval loop.",
      },
      {
        name: "Require approval before notifications",
        effectType: "notify",
        effect: "require_approval",
        priority: 950,
        reason: "Owner review first preset: messages and outbound notifications wait for approval.",
      },
      {
        name: "Require approval before external changes",
        effectType: "write",
        effect: "require_approval",
        priority: 940,
        reason: "Owner review first preset: agents can draft changes, but the owner approves before anything changes outside HiveWright.",
      },
      {
        name: "Require approval before financial actions",
        effectType: "financial",
        effect: "require_approval",
        priority: 930,
        reason: "Owner review first preset: spending, refunds, or payment changes require owner approval.",
      },
      {
        name: "Require approval before system changes",
        effectType: "system",
        effect: "require_approval",
        priority: 920,
        reason: "Owner review first preset: configuration and system-level changes require owner approval.",
      },
      {
        name: "Block destructive actions",
        effectType: "destructive",
        effect: "block",
        priority: 910,
        reason: "Owner review first preset: deletes and irreversible actions stay blocked until you change this rule.",
      },
    ];

  for (const policy of policies) {
    await tx`
      INSERT INTO action_policies (
        hive_id, name, enabled, connector, operation, effect_type, role_slug,
        effect, priority, reason, conditions
      )
      VALUES (
        ${hiveId}::uuid,
        ${policy.name},
        true,
        ${"connector" in policy ? policy.connector ?? null : null},
        ${"operation" in policy ? policy.operation ?? null : null},
        ${policy.effectType},
        null,
        ${policy.effect},
        ${policy.priority},
        ${policy.reason},
        ${tx.json({} as Parameters<Sql["json"]>[0])}
      )
    `;
  }
}

async function installConnector(tx: SqlExecutor, hiveId: string, connector: ConnectorSetup): Promise<InstalledConnectorSetupResult> {
  const def = getConnectorDefinition(connector.connectorSlug);
  if (!def) {
    throw new HiveSetupError("One selected service is no longer available. Please review your services and try again.");
  }

  if (def.authType === "oauth2") {
    throw new HiveSetupError(`${def.name} needs browser authorization after the hive is created.`);
  }

  for (const field of def.setupFields) {
    if (field.required && !connector.fields[field.key]) {
      throw new HiveSetupError(`Please complete ${field.label} before creating this hive.`);
    }
  }

  const requestedScopes: unknown[] = Array.isArray(connector.grantedScopes) ? connector.grantedScopes : [];
  if (!requestedScopes.every((scope) => typeof scope === "string")) {
    throw new HiveSetupError("One selected service has invalid permissions. Please review your services and try again.", 400);
  }
  const declaredScopes = new Set(def.scopes.map((scope) => scope.key));
  const unknownScope = requestedScopes.find((scope): scope is string => typeof scope === "string" && !declaredScopes.has(scope));
  if (unknownScope) {
    throw new HiveSetupError("One selected service requested an unknown permission. Please review your services and try again.", 400);
  }
  const grantedScopes = Array.from(new Set([
    ...def.scopes.filter((scope) => scope.required).map((scope) => scope.key),
    ...(requestedScopes as string[]),
  ]));

  const secretValues: Record<string, string> = {};
  const publicConfig: Record<string, string> = {};
  for (const field of def.setupFields) {
    const value = connector.fields[field.key];
    if (value === undefined || value === null || value === "") continue;
    if (def.secretFields.includes(field.key)) {
      secretValues[field.key] = value;
    } else {
      publicConfig[field.key] = value;
    }
  }

  const encryptionKey = process.env.ENCRYPTION_KEY || "";
  let credentialId: string | null = null;
  if (Object.keys(secretValues).length > 0) {
    if (!encryptionKey) {
      throw new HiveSetupError("This service needs a secret, but secure secret storage is not ready. Set it up, then try again.");
    }
    const credential = await storeCredential(tx as unknown as Sql, {
      hiveId,
      name: `${def.name}: ${connector.displayName}`,
      key: `connector:${def.slug}:${Date.now()}`,
      value: JSON.stringify(secretValues),
      rolesAllowed: [],
      encryptionKey,
    });
    credentialId = credential.id;
  }

  const [row] = await tx`
    INSERT INTO connector_installs (hive_id, connector_slug, display_name, config, granted_scopes, credential_id)
    VALUES (${hiveId}::uuid, ${def.slug}, ${connector.displayName}, ${tx.json(publicConfig)}, ${tx.json(grantedScopes)}, ${credentialId})
    RETURNING id, connector_slug AS "connectorSlug", display_name AS "displayName"
  `;

  const testOperation = def.operations.find((operation) =>
    ["test_connection", "self_test"].includes(operation.slug)
    && operation.governance.effectType === "system"
    && operation.governance.defaultDecision === "allow"
    && operation.governance.riskTier === "low"
  );
  const hasSafeTest = Boolean(testOperation);

  if (testOperation) {
    const testResult = await invokeConnectorReadOnlyOrSystem(tx as unknown as Sql, {
      installId: row.id as string,
      operation: testOperation.slug,
      args: {},
      actor: "setup-wizard",
    });
    if (!testResult.success) {
      throw new HiveSetupError(`${def.name} did not pass its setup test: ${testResult.error ?? "test failed"}`);
    }
  }

  return {
    id: row.id as string,
    connectorSlug: row.connectorSlug as string,
    displayName: row.displayName as string,
    requiresDispatcherRestart: def.requiresDispatcherRestart === true,
    hasSafeTest,
  };
}

async function saveRoleOverrides(tx: SqlExecutor, hiveId: string, roleOverrides: Record<string, RoleOverride>) {
  for (const [roleSlug, override] of Object.entries(roleOverrides)) {
    const [role] = await tx<{ slug: string }[]>`
      SELECT slug FROM role_templates WHERE slug = ${roleSlug} LIMIT 1
    `;
    if (!role) {
      throw new HiveSetupError("A selected role could not be updated. Please review the runtime choices and try again.");
    }
    await saveHiveRoleOverride(tx, hiveId, roleSlug, {
      adapterType: override.adapterType,
      recommendedModel: override.recommendedModel,
    });
  }
}

async function validateHiveSetupRequest(sqlClient: Sql, body: HiveSetupRequest) {
  const hive = body.hive ?? {};
  const { name, slug, type, kind } = hive;

  if (!name || !slug || !type) {
    throw new HiveSetupError("Please add a hive name and type before creating it.", 400);
  }
  if (!kind) {
    throw new HiveSetupError("Please choose what kind of hive you are creating.", 400);
  }
  if (!isHiveKind(kind)) {
    throw new HiveSetupError("Please choose a valid hive kind.", 400);
  }
  if (typeof slug !== "string" || !isValidHiveAddress(slug)) {
    throw new HiveSetupError("Please use only lowercase letters, numbers, and dashes for the hive address.", 400);
  }

  const existingHive = await sqlClient`SELECT id FROM hives WHERE slug = ${slug} LIMIT 1`;
  if (existingHive.length > 0) {
    throw new HiveSetupError(
      "That hive address is already in use. Please choose a different hive name or custom hive address.",
      409,
    );
  }

  for (const project of body.projects ?? []) {
    if (!project.name || !project.slug) {
      throw new HiveSetupError("Please complete or remove unfinished projects before creating this hive.", 400);
    }
    if (!PROJECT_SLUG_RE.test(project.slug)) {
      throw new HiveSetupError("Please use only lowercase letters, numbers, and dashes for project addresses.", 400);
    }
  }
}

export async function runHiveSetup(
  sqlClient: Sql,
  body: HiveSetupRequest,
  options?: RunHiveSetupOptions,
) {
  await validateHiveSetupRequest(sqlClient, body);

  const hive = body.hive ?? {};
  const { name, slug, type, kind, description, mission } = hive;
  const hiveKind = kind as HiveKind;
  const connectors = body.connectors ?? [];
  const projects = body.projects ?? [];
  const operatingPreferences = normalizeOperatingPreferences(body.operatingPreferences);
  const createdDirectories = new Set<string>();

  try {
    return await sqlClient.begin(async (tx) => {
      const workspacePath = hiveProjectsPath(slug!);
      const [hiveRow] = await tx`
        INSERT INTO hives (name, slug, type, kind, operating_mode, description, mission, workspace_path)
        VALUES (${name!}, ${slug!}, ${type!}, ${hiveKind}, ${"exploring"}, ${description || null}, ${mission || null}, ${workspacePath})
        RETURNING id, name, slug, type, kind, description
      `;
      const hiveId = hiveRow.id as string;

      createHiveDirectories(slug!, createdDirectories);
      maybeFailSetup("hive-record", options);

      await seedDefaultSchedules(tx as unknown as Sql, {
        id: hiveId,
        name: hiveRow.name as string,
        description: (hiveRow.description as string | null) ?? null,
        kind: hiveKind,
      }, {
        coreEnabled: true,
        proactiveEnabled: operatingPreferences.proactiveWork,
      });

      await saveAdapterConfig(tx, "dispatcher", {
        maxConcurrentTasks: operatingPreferences.maxConcurrentAgents,
        setupPreset: "owner-setup",
      });
      await saveAdapterConfig(tx, "work-intake", workIntakeConfigForPreset(operatingPreferences.requestSorting));
      await saveAdapterConfig(tx, "memory-search", {
        enabled: operatingPreferences.memorySearch,
        prepareOnSetup: operatingPreferences.memorySearch,
        setupPreset: operatingPreferences.memorySearch ? "ready" : "off",
      }, hiveId);

      await saveRoleOverrides(tx, hiveId, body.roleOverrides ?? {});
      maybeFailSetup("role-overrides", options);

      await seedSafetyPolicies(tx, hiveId, body.safetyPreset ?? "owner_review_first");
      maybeFailSetup("action-policies", options);

      const initialGoal = body.initialGoal?.trim() || defaultInitialGoalForHiveKind(hiveKind, hiveRow.name as string);
      const defaultOperatingProfile = deriveOperatingProfileDefaults({
        hiveId,
        name: hiveRow.name as string,
        kind: hiveKind,
        description: (description as string | null | undefined) ?? null,
        mission: (mission as string | null | undefined) ?? null,
        initialGoal,
        safetyPreset: body.safetyPreset ?? "owner_review_first",
      });
      await upsertOperatingProfile(tx, hiveId, defaultOperatingProfile);

      const installedConnectors: InstalledConnectorSetupResult[] = [];
      for (const connector of connectors) {
        installedConnectors.push(await installConnector(tx, hiveId, connector));
      }
      maybeFailSetup("connectors", options);

      const hiveProjectsRoot = requireHiveProjectsRoot(slug!);
      for (const project of projects) {
        const projectWorkspacePath = requireContainedWorkspace(
          project.workspacePath || path.join(hiveProjectsRoot, project.slug),
          hiveProjectsRoot,
        );
        createProjectDirectory(projectWorkspacePath, createdDirectories);
        if (project.gitRepo === true && !isGitRepository(projectWorkspacePath)) {
          throw new HiveSetupError("Git-backed projects must point at an existing Git repository.");
        }
        await tx`
          INSERT INTO projects (hive_id, slug, name, workspace_path, git_repo)
          VALUES (${hiveId}, ${project.slug}, ${project.name}, ${projectWorkspacePath}, ${project.gitRepo === true})
        `;
      }
      maybeFailSetup("projects", options);

      if (initialGoal) {
        const [goal] = await tx`
          INSERT INTO goals (hive_id, title, description)
          VALUES (${hiveId}, ${initialGoal.slice(0, 200)}, ${initialGoal})
          RETURNING id
        `;
        await tx`SELECT pg_notify('new_goal', ${goal.id})`;
      }
      maybeFailSetup("initial-goal", options);

      return {
        id: hiveId,
        name: hiveRow.name,
        slug: hiveRow.slug,
        type: hiveRow.type,
        kind: hiveRow.kind,
        installedConnectors,
      };
    });
  } catch (error) {
    cleanupDirectories(createdDirectories);
    throw error;
  }
}
