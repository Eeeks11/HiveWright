import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { SessionContext } from "../adapters/types";
import type { ClaimedTask } from "./types";
import { evaluateTaskWorkspacePolicy, isHiveWrightCodeTask } from "./workspace-policy";

afterEach(() => {
  delete process.env.HIVEWRIGHT_FORBIDDEN_SOURCE_ROOTS;
  delete process.env.HIVEWRIGHT_APPROVED_CODE_WORKSPACE_ROOTS;
});

const baseTask: ClaimedTask = {
  id: "task-1",
  hiveId: "hive-1",
  assignedTo: "dev-agent",
  createdBy: "goal-supervisor",
  status: "active",
  priority: 10,
  title: "Fix HiveWright dashboard task stream",
  brief: "Patch the HiveWright dashboard code and add tests.",
  parentTaskId: null,
  goalId: null,
  sprintNumber: null,
  qaRequired: false,
  acceptanceCriteria: "Vitest covers the task stream fix.",
  retryCount: 0,
  doctorAttempts: 0,
  failureReason: null,
  adapterOverride: null,
  modelOverride: null,
  projectId: null,
};

function ctx(overrides: Partial<SessionContext> = {}): SessionContext {
  const task = overrides.task ?? baseTask;
  return {
    task,
    roleTemplate: { slug: task.assignedTo, department: "engineering", roleMd: null, soulMd: null, toolsMd: null },
    memoryContext: { roleMemory: [], hiveMemory: [], insights: [], capacity: "none" },
    skills: [],
    standingInstructions: [],
    goalContext: null,
    projectWorkspace: "/home/trent/businesses/example",
    gitBackedProject: false,
    baseProjectWorkspace: "/home/trent/businesses/example",
    workspaceIsolation: null,
    model: "openai-codex/gpt-5.5",
    fallbackModel: null,
    credentials: {},
    ...overrides,
  };
}

describe("isHiveWrightCodeTask", () => {
  it("classifies HiveWright dev-agent implementation work as product code work", () => {
    expect(isHiveWrightCodeTask(baseTask)).toBe(true);
  });

  it("does not classify non-code business writing as product code work", () => {
    expect(isHiveWrightCodeTask({
      ...baseTask,
      assignedTo: "writer",
      title: "Draft customer email",
      brief: "Write a short customer update for Short Stay Sales.",
      acceptanceCriteria: "No code changes.",
    })).toBe(false);
  });
});

describe("evaluateTaskWorkspacePolicy", () => {
  it("blocks HiveWright code-changing tasks without an explicit git-backed project", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx());

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("no approved git-backed project_id");
      expect(decision.reason).toContain("approved Git development workflow");
    }
  });

  it("blocks forbidden legacy v2 paths before any agent can spawn", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      projectWorkspace: "/home/trent/hivewrightv2",
      baseProjectWorkspace: "/home/trent/hivewrightv2",
      gitBackedProject: true,
      task: { ...baseTask, projectId: "project-1" },
      workspaceIsolation: {
        status: "active",
        baseWorkspacePath: "/home/trent/hivewrightv2",
        worktreePath: "/home/trent/hivewrightv2/.claude/worktrees/task-1",
        branchName: "hw/task/task-1-dev-agent",
        isolationActive: true,
        reused: false,
        reason: null,
      },
    }));

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("forbidden HiveWright legacy/archive path");
      expect(decision.reason).toContain("/home/trent/hivewrightv2");
    }
  });

  it("keeps default forbidden roots even when env adds extra roots", () => {
    process.env.HIVEWRIGHT_FORBIDDEN_SOURCE_ROOTS = "/tmp/some-other-forbidden-root";

    const decision = evaluateTaskWorkspacePolicy(ctx({
      projectWorkspace: "/home/trent/hivewrightv2",
      baseProjectWorkspace: "/home/trent/hivewrightv2",
      gitBackedProject: true,
      task: { ...baseTask, projectId: "project-1" },
    }), { requireActiveIsolation: false });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("/home/trent/hivewrightv2");
    }
  });

  it("blocks symlink aliases that resolve into forbidden roots", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hw-policy-"));
    const aliasPath = path.join(tmpDir, "legacy-alias");
    try {
      fs.symlinkSync("/home/trent/hivewrightv2", aliasPath, "dir");
      const decision = evaluateTaskWorkspacePolicy(ctx({
        projectWorkspace: aliasPath,
        baseProjectWorkspace: aliasPath,
        gitBackedProject: true,
        task: { ...baseTask, projectId: "project-1" },
      }), { requireActiveIsolation: false });

      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toContain("forbidden HiveWright legacy/archive path");
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("blocks archived legacy checkouts as source workspaces", () => {
    const archivePath = "/home/trent/archive/legacy-ai-systems/hivewrightv2-legacy-disabled-20260608-210321";
    const decision = evaluateTaskWorkspacePolicy(ctx({
      projectWorkspace: archivePath,
      baseProjectWorkspace: archivePath,
      gitBackedProject: true,
      task: { ...baseTask, projectId: "project-1" },
      workspaceIsolation: {
        status: "active",
        baseWorkspacePath: archivePath,
        worktreePath: `${archivePath}/.claude/worktrees/task-1`,
        branchName: "hw/task/task-1-dev-agent",
        isolationActive: true,
        reused: false,
        reason: null,
      },
    }));

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("forbidden HiveWright legacy/archive path");
    }
  });

  it("blocks the local operational install for product code work", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      projectWorkspace: "/home/trent/apps/HiveWright",
      baseProjectWorkspace: "/home/trent/apps/HiveWright",
      gitBackedProject: true,
      task: { ...baseTask, projectId: "project-1" },
      workspaceIsolation: {
        status: "active",
        baseWorkspacePath: "/home/trent/apps/HiveWright",
        worktreePath: "/home/trent/apps/HiveWright/.claude/worktrees/task-1",
        branchName: "hw/task/task-1-dev-agent",
        isolationActive: true,
        reused: false,
        reason: null,
      },
    }));

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("local operational install");
    }
  });

  it("allows approved git-backed product code tasks only when an isolated worktree is active", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      projectWorkspace: "/home/trent/dev/hivewright",
      baseProjectWorkspace: "/home/trent/dev/hivewright",
      gitBackedProject: true,
      task: { ...baseTask, projectId: "project-1" },
      workspaceIsolation: {
        status: "active",
        baseWorkspacePath: "/home/trent/dev/hivewright",
        worktreePath: "/home/trent/dev/hivewright/.claude/worktrees/task-1",
        branchName: "hw/task/task-1-dev-agent",
        isolationActive: true,
        reused: false,
        reason: null,
      },
    }));

    expect(decision).toMatchObject({ allowed: true });
  });

  it("allows approved git-backed product code tasks before provisioning when pre-provision mode is used", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      projectWorkspace: "/home/trent/dev/hivewright",
      baseProjectWorkspace: "/home/trent/dev/hivewright",
      gitBackedProject: true,
      task: { ...baseTask, projectId: "project-1" },
      workspaceIsolation: null,
    }), { requireActiveIsolation: false });

    expect(decision).toMatchObject({ allowed: true });
  });

  it("allows non-HiveWright code tasks from git-backed isolated workspaces without HiveWright approved-root matching", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      projectWorkspace: "/home/trent/dev/customer-portal",
      baseProjectWorkspace: "/home/trent/dev/customer-portal",
      gitBackedProject: true,
      task: {
        ...baseTask,
        projectId: "project-2",
        title: "Fix customer portal auth bug",
        brief: "Patch the customer portal backend code and add tests.",
        acceptanceCriteria: "Tests cover the auth bug.",
      },
      workspaceIsolation: {
        status: "active",
        baseWorkspacePath: "/home/trent/dev/customer-portal",
        worktreePath: "/home/trent/dev/customer-portal/.claude/worktrees/task-1",
        branchName: "hw/task/task-1-dev-agent",
        isolationActive: true,
        reused: false,
        reason: null,
      },
    }));

    expect(decision).toMatchObject({ allowed: true });
  });

  it("lets non-code business tasks run in clean task workspaces", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      task: {
        ...baseTask,
        assignedTo: "writer",
        title: "Draft owner update",
        brief: "Write a summary for the owner.",
        acceptanceCriteria: "Clear and concise.",
      },
      projectWorkspace: "/home/trent/businesses/short-stay-sales",
      baseProjectWorkspace: "/home/trent/businesses/short-stay-sales",
      gitBackedProject: false,
    }));

    expect(decision).toMatchObject({ allowed: true });
  });

  it("does not treat source-evidence research in the HiveWright hive as product code", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      task: {
        ...baseTask,
        assignedTo: "research-analyst",
        title: "Daily AI and market signal scan",
        brief: "Review source links for HiveWright market context and write an evidence summary. Do not change code or repositories.",
        acceptanceCriteria: "Cite sources and identify decisions.",
      },
      projectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/market-scan",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/market-scan",
      gitBackedProject: false,
    }));

    expect(decision).toMatchObject({ allowed: true });
  });

  it("does not treat read-only HiveWright market/runtime scans as product code", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      task: {
        ...baseTask,
        assignedTo: "research-analyst",
        title: "Daily AI and market signal scan",
        brief: "Scan only the highest-signal changes relevant to HiveWright: competitors, pricing, model/runtime changes, security developments, and customer demand signals. Use guarded APIs and durable artifacts only. Do not edit any local HiveWright repository or implementation code.",
        acceptanceCriteria: "Produce a concise brief with only the material findings.",
      },
      projectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/market-scan",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/market-scan",
      gitBackedProject: false,
    }));

    expect(decision).toMatchObject({ allowed: true });
  });

  it("does not treat external business world scans mentioning repo verification as product code", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      task: {
        ...baseTask,
        assignedTo: "research-analyst",
        title: "Daily world scan",
        brief: "Run the daily world scan for Short Stay Sales. Hive context: Australian marketplace for buying and selling Airbnb and short-stay accommodation investment properties; current imported context needs live repo/site/runtime verification. Do not propose HiveWright product improvements, AI model/runtime changes, or internal platform work from this business-hive scan.",
        acceptanceCriteria: "Produce a concise external-signal summary only.",
      },
      projectWorkspace: "/home/trent/.hivewright/hives/short-stay-sales",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/short-stay-sales",
      gitBackedProject: false,
    }));

    expect(decision).toMatchObject({ allowed: true });
  });

  it("does not treat quality/doctor diagnosis context as product code work", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      task: {
        ...baseTask,
        assignedTo: "doctor",
        title: "Quality diagnosis: Hive supervisor heartbeat — 22 finding(s)",
        brief: "Use exactly one cause category and produce a fenced JSON diagnosis. Evidence includes previous workspace_policy_blocked text and runtime-route logs; do not patch source code.",
        acceptanceCriteria: "Diagnosis only.",
      },
      projectWorkspace: "/home/trent/.hivewright/hives/hivewright",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/hivewright",
      gitBackedProject: false,
    }));

    expect(decision).toMatchObject({ allowed: true });
  });

  it("never treats doctor recovery tasks as direct source-editing work", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      task: {
        ...baseTask,
        assignedTo: "doctor",
        title: "[Doctor] Diagnose: Reconcile restored Whiston bookkeeping reference document",
        brief: "Failed task context mentions reference document UI, workspace_policy_blocked, repository flow, and source logs. Diagnose and route the next action; do not edit source directly.",
        acceptanceCriteria: "Diagnosis or follow-up task only.",
      },
      projectWorkspace: "/home/trent/.hivewright/hives/whiston-management",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/whiston-management",
      gitBackedProject: false,
    }));

    expect(decision).toMatchObject({ allowed: true });
  });

  it("does not treat business migration/readiness registers as HiveWright product code", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      task: {
        ...baseTask,
        assignedTo: "operations-coordinator",
        title: "Convert AGP June 2026 readiness signals into an internal action register",
        brief: "Read a HiveWright hive artifact and cover Oneflare closure/migration by 30 June 2026. Do not change code or repositories.",
        acceptanceCriteria: "Produce the internal action register only.",
      },
      projectWorkspace: "/home/trent/.hivewright/hives/aussie-garden-pros/projects/operations",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/aussie-garden-pros/projects/operations",
      gitBackedProject: false,
    }));

    expect(decision).toMatchObject({ allowed: true });
  });

  it("does not block non-code QA replanning for business evidence work", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      task: {
        ...baseTask,
        assignedTo: "goal-supervisor",
        title: "[Replan] QA failed repeatedly: Traceable prefab/modular terminology and search evidence pack",
        brief: "## QA Failure Re-Planning\nThe following sprint task failed QA repeatedly and needs automatic re-planning or decomposition. Original brief: Sprint 1 needs traceable evidence, not broad narratives. Owner guardrails prohibit public/production changes.",
        acceptanceCriteria: "Create follow-up non-code research tasks only.",
      },
      projectWorkspace: "/home/trent/.hivewright/hives/cabin-connect/projects",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/cabin-connect/projects",
      gitBackedProject: false,
    }));

    expect(decision).toMatchObject({ allowed: true });
  });

  it("does not block readiness evidence refreshes that do not edit source", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      task: {
        ...baseTask,
        assignedTo: "infrastructure-agent",
        title: "Refresh readiness, backup, and restore evidence after runtime-path remediation",
        brief: "Rerun current install proofs so audit evidence is current: dispatcher-health, runtime-path, backup, and restore-smoke. Store results in a new dated readiness directory and summarize backup retention gaps if any remain.",
        acceptanceCriteria: "A new dated readiness artifact set exists with dispatcher health, runtime path, backup, and restore-smoke results captured.",
      },
      projectWorkspace: "/home/trent/.hivewright/readiness",
      baseProjectWorkspace: "/home/trent/.hivewright/readiness",
      gitBackedProject: false,
    }));

    expect(decision).toMatchObject({ allowed: true });
  });

  it("does not block governed skill QA reviews as source editing", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      task: {
        ...baseTask,
        assignedTo: "qa",
        title: "[Skill QA] Review: dev-agent-qa-failure-skill-improvement",
        brief: "A new skill candidate has been proposed by role dev-agent and requires QA review. Please review the skill content for correctness, clarity, scope, and no sensitive data.",
        acceptanceCriteria: "Approve or reject the candidate through the governed skill lifecycle API.",
      },
      projectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects",
      gitBackedProject: false,
    }));

    expect(decision).toMatchObject({ allowed: true });
  });

  it("does not block read-only QA of business diagnostics artifacts as source editing", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      task: {
        ...baseTask,
        assignedTo: "qa",
        title: "[QA] Review: Classify diagnostics read-path metadata exposure",
        brief: "Review the exact diagnostic artifacts and touched read paths, including model-routing/model-health route behavior as needed. Classify response bodies, logs, saved artifacts, and operator runbook recommendations against the Short Stay Sales governance matrix. Read-only only: do not change production routes, auth, deployment config, credentials, routing defaults, probe schedules, quarantine state, candidate ordering, public copy, seller-intake workflow, or protected records.",
        acceptanceCriteria: "First line pass or fail; include concise evidence-based issues only.",
      },
      projectWorkspace: "/home/trent/.hivewright/hives/short-stay-sales/projects",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/short-stay-sales/projects",
      gitBackedProject: false,
    }));

    expect(decision).toMatchObject({ allowed: true });
  });

  it("still treats database migration implementation work as HiveWright product code", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      task: {
        ...baseTask,
        assignedTo: "backend-engineer",
        title: "Implement HiveWright database migration for task routing",
        brief: "Patch the dispatcher source code and add a schema migration.",
        projectId: "project-1",
      },
      projectWorkspace: "/home/trent/dev/hivewright",
      baseProjectWorkspace: "/home/trent/dev/hivewright",
      gitBackedProject: true,
      workspaceIsolation: {
        status: "active",
        worktreePath: "/home/trent/dev/hivewright/.worktrees/task-routing",
        baseWorkspacePath: "/home/trent/dev/hivewright",
        branchName: "hw/task/task-routing-backend-engineer",
        isolationActive: true,
        reused: false,
        reason: null,
      },
    }));

    expect(decision).toMatchObject({ allowed: true });
  });

});
