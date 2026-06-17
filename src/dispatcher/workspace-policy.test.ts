import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { SessionContext } from "../adapters/types";
import type { ClaimedTask } from "./types";
import { evaluateTaskWorkspacePolicy, isCodeChangingTask, isHiveWrightCodeTask } from "./workspace-policy";

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

  it("does not let stale HiveWright workspace-policy feedback reclassify business app code as HiveWright product code", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      projectWorkspace: "/home/trent/.hivewright/hives/short-stay-sales/projects/short-stay-sales",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/short-stay-sales/projects/short-stay-sales",
      gitBackedProject: true,
      task: {
        ...baseTask,
        assignedTo: "dev-agent",
        projectId: "short-stay-sales-app",
        title: "Sprint 6: Project-scoped technical map and gate test targets",
        brief: "Inspect and map the approved Short Stay Sales app repository. Add failing tests or test stubs if the repo test framework is clear.\n### QA Feedback\nworkspace_policy_blocked: HiveWright code-changing task resolved to an unapproved workspace (/home/trent/.hivewright/hives/short-stay-sales/projects/short-stay-sales). Approved roots: /home/twhis/dev/hivewright, /home/trent/dev/hivewright.",
        acceptanceCriteria: "Map routes, schema, and tests for the Short Stay Sales app.",
      },
      workspaceIsolation: {
        status: "active",
        baseWorkspacePath: "/home/trent/.hivewright/hives/short-stay-sales/projects/short-stay-sales",
        worktreePath: "/home/trent/.hivewright/hives/short-stay-sales/projects/short-stay-sales/.claude/worktrees/task-1",
        branchName: "hw/task/task-1-dev-agent",
        isolationActive: true,
        reused: false,
        reason: null,
      },
    }));

    expect(decision).toMatchObject({ allowed: true });
    expect(decision.signals).not.toContain("hivewright_product_code_task");
  });

  it("allows read-only project-scoped technical maps without requiring code workspace policy", () => {
    const task = {
      ...baseTask,
      assignedTo: "dev-agent",
      projectId: "short-stay-sales-app",
      title: "Sprint 7: Fresh project-scoped technical map and gate test targets",
      brief: "Produce a fresh, read-only project-scoped technical implementation map and test-target handoff for the approved Short Stay Sales app project. Read and map the approved app repository only. Do not create, edit, delete, or commit files in this task. Do not add tests or test stubs in this task; instead, identify exact future test file paths, cases, and commands.",
      acceptanceCriteria: "Verify the registered project workspace and provide future test file paths without changing files.",
    };

    expect(isCodeChangingTask(task)).toBe(false);
    expect(evaluateTaskWorkspacePolicy(ctx({
      task,
      projectWorkspace: "/home/trent/.hivewright/hives/short-stay-sales/projects/short-stay-sales",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/short-stay-sales/projects/short-stay-sales",
      gitBackedProject: true,
      workspaceIsolation: null,
    }))).toMatchObject({ allowed: true });
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

  it("allows secret-free read-only infrastructure verification without a git-backed project", () => {
    const task = {
      ...baseTask,
      assignedTo: "infrastructure-agent",
      title: "Verify live site, repo, DB, and infrastructure state",
      brief: "Conduct a secret-free, read-only verification of the shortstaysales.com.au live site, GitHub repo integrity, Supabase database state, and Vercel/Resend deployment posture. Document current findings without modifying any production or config secrets.",
      acceptanceCriteria: "Produce a current-state report only; do not modify code, repositories, deployment config, or secrets.",
    };

    expect(isCodeChangingTask(task)).toBe(false);
    expect(evaluateTaskWorkspacePolicy(ctx({
      task,
      projectWorkspace: "/home/trent/.hivewright/hives/short-stay-sales/projects/read-only-infra-verification",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/short-stay-sales/projects/read-only-infra-verification",
      gitBackedProject: false,
    }))).toMatchObject({ allowed: true });
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

  it("does not block repository-neutral canonical inventory tasks as code-changing", () => {
    const task = {
      ...baseTask,
      assignedTo: "reference-document-reviewer",
      title: "Replacement Sprint 1 canonical inventory for completed output residue",
      brief: "Produce the replacement Sprint 1 canonical inventory for completed output residue. Repository-Neutral Boundary: This task is not scoped to a git-backed project or codebase. Do not run git commands. Do not require a git-backed project, project checkout, code change, local filesystem artifact, branch, worktree, or commit. Use internal HiveWright records, task outputs, decisions, memories, retained work product references, and task result text.",
      acceptanceCriteria: "Inventory enumerates every source task exactly once and states that no direct implementation or code-changing work was spawned.",
    };

    expect(isCodeChangingTask(task)).toBe(false);
    expect(evaluateTaskWorkspacePolicy(ctx({
      task,
      projectWorkspace: "/home/trent/.hivewright/hives/cabin-connect/projects/governance",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/cabin-connect/projects/governance",
      gitBackedProject: false,
    }))).toMatchObject({ allowed: true });
  });

  it("does not block source-backed research packets that explicitly forbid git work", () => {
    const task = {
      ...baseTask,
      assignedTo: "research-analyst",
      title: "Verify June 10 privacy-surface signals and locate current-tech packet",
      brief: "Create the evidence base for the canonical privacy-surface inventory goal. This is Sprint 1 research and clarification only. Use only verified official sources and internal artifact/work-product records. Do not run git commands unless this task is explicitly scoped to a git-backed project/repository.",
      acceptanceCriteria: "Official source URLs and artifact references are cited; no code, branch, worktree, or commit is required.",
    };

    expect(isCodeChangingTask(task)).toBe(false);
    expect(evaluateTaskWorkspacePolicy(ctx({
      task,
      projectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/privacy-surface",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/privacy-surface",
      gitBackedProject: false,
    }))).toMatchObject({ allowed: true });
  });

  it("does not block repository-neutral duplicate-decision addendum inventory tasks", () => {
    const task = {
      ...baseTask,
      assignedTo: "reference-document-reviewer",
      title: "Sprint 2 duplicate-decision addendum for canonical residue inventory",
      brief: "Produce a duplicate-decision addendum for canonical residue inventory. Do not run git commands. Do not inspect or modify code. Do not create branches, worktrees, commits, local repo artifacts, production changes, provider contacts, or source/API/config changes. It is repository-neutral and requires no git/project/code change.",
      acceptanceCriteria: "Cite internal HiveWright records and state that no prohibited downstream work was spawned.",
    };

    expect(isCodeChangingTask(task)).toBe(false);
    expect(evaluateTaskWorkspacePolicy(ctx({
      task,
      projectWorkspace: "/home/trent/.hivewright/hives/cabin-connect/projects/governance",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/cabin-connect/projects/governance",
      gitBackedProject: false,
    }))).toMatchObject({ allowed: true });
  });

  it("does not block bounded runtime preflight route investigations that forbid code work", () => {
    const task = {
      ...baseTask,
      assignedTo: "system-health-auditor",
      title: "Bounded hive supervisor adapter/preflight route investigation",
      brief: "Treat this as one deduped runtime/session/model-route failure pattern, not separate Doctor or implementation tasks. Re-check live route-health counts and test the supervisor/adapter/preflight/session path without spawning implementation work. Do not run git commands. Do not inspect or modify code. If a true code defect remains, hand it off separately as one bounded implementation follow-up with evidence.",
      acceptanceCriteria: "Route-health counts, tested route/session path, root-cause bucket, and recommended operational action only.",
    };

    expect(isCodeChangingTask(task)).toBe(false);
    expect(evaluateTaskWorkspacePolicy(ctx({
      task,
      projectWorkspace: "/home/trent/.hivewright/hives/whiston-management/projects/runtime-triage",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/whiston-management/projects/runtime-triage",
      gitBackedProject: false,
    }))).toMatchObject({ allowed: true });
  });

  it("does not block Short Stay Sales QA wrappers that review read-only evidence", () => {
    const task = {
      ...baseTask,
      assignedTo: "qa",
      title: "[QA] Review: [Sprint 2 Recovery] Read-only live endpoint and network posture audit",
      brief: "## QA Review\n\n[lean-context] QA must verify only the latest deliverable evidence. Do not restate full transcripts unless needed.\n\n**Original Task:** [Sprint 2 Recovery] Read-only live endpoint and network posture audit\n\n### Original Brief\nCollect fresh read-only live endpoint and network posture evidence for shortstaysales.com.au using current UTC timestamps and no side effects. Audit only public network and endpoint posture.",
      acceptanceCriteria: "Pass/fail the deliverable evidence; do not patch source code.",
    };

    expect(isCodeChangingTask(task)).toBe(false);
    expect(evaluateTaskWorkspacePolicy(ctx({
      task,
      projectWorkspace: "/home/trent/.hivewright/hives/short-stay-sales/projects/runtime-audit",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/short-stay-sales/projects/runtime-audit",
      gitBackedProject: false,
    }))).toMatchObject({ allowed: true });
  });

  it("does not let QA wrapper wording suppress explicit source-edit requests", () => {
    const task = {
      ...baseTask,
      assignedTo: "qa",
      title: "[QA] Review: Dashboard API source-code fix",
      brief: "## QA Review\n\nPatch the HiveWright dashboard/API source code and add a Vitest regression for the route.",
      acceptanceCriteria: "Code changes and tests are committed.",
    };

    expect(isCodeChangingTask(task)).toBe(true);
    expect(evaluateTaskWorkspacePolicy(ctx({
      task,
      projectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/review",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/review",
      gitBackedProject: false,
    }))).toMatchObject({ allowed: false });
  });

  it("does not block Short Stay Sales document-only remediation artifacts", () => {
    const task = {
      ...baseTask,
      assignedTo: "document-manager",
      title: "Finalize remediation artifact with provenance gating and finance-gated backlog",
      brief: "Replace the blocked remediation brief with a document-only task that turns the evidence matrix and completed engineering report into the final decision-ready remediation artifact. Keep the inventory-separation states limited to safety, provenance, and publication-readiness. Label any revenue/payment/admin monetization work as owner/finance-gated backlog only. Required output: A final markdown artifact that includes the route/flow matrix, placeholder-vs-real inventory assessment, and minimum remediation backlog.",
      acceptanceCriteria: "Markdown artifact only; no implementation or source-code changes.",
    };

    expect(isCodeChangingTask(task)).toBe(false);
    expect(evaluateTaskWorkspacePolicy(ctx({
      task,
      projectWorkspace: "/home/trent/.hivewright/hives/short-stay-sales/projects/remediation-docs",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/short-stay-sales/projects/remediation-docs",
      gitBackedProject: false,
    }))).toMatchObject({ allowed: true });
  });

  it("does not block Short Stay Sales compliance source-use boundary documents", () => {
    const task = {
      ...baseTask,
      assignedTo: "compliance-risk-analyst",
      title: "Add source-use boundary requirements to marketplace remediation backlog",
      brief: "Perform a document-only compliance requirements addendum for the active Short Stay Sales remediation artifact/backlog. Required output: requirements for detailed provenance tracking for manual or seller-provided inputs, acquisition-boundary checks, source attribution, public-display gating, and manual review handoff. The addendum is document-only and does not propose production, auth, payment, email, DNS, integration, source/API/config changes, scraping, or bulk crawling.",
      acceptanceCriteria: "The addendum is document-only and no implementation or source-code changes are required.",
    };

    expect(isCodeChangingTask(task)).toBe(false);
    expect(evaluateTaskWorkspacePolicy(ctx({
      task,
      projectWorkspace: "/home/trent/.hivewright/hives/short-stay-sales/projects/remediation-docs",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/short-stay-sales/projects/remediation-docs",
      gitBackedProject: false,
    }))).toMatchObject({ allowed: true });
  });

  it("does not treat HTTP endpoint references in QA evidence as source edits", () => {
    const task = {
      ...baseTask,
      assignedTo: "qa",
      title: "[QA] Review: Document live-site and API evidence into route and inventory matrix",
      brief: "## QA Review\n\nReview the document-only deliverable evidence. The matrix cites `PATCH /api/listing/[id]/status` and an Admin dashboard evidence reference, but the task is QA-only and must verify the artifact, not patch source code. First non-empty line must be PASS or FAIL.",
      acceptanceCriteria: "QA decision only; do not run git commands or modify code.",
    };

    expect(isCodeChangingTask(task)).toBe(false);
    expect(evaluateTaskWorkspacePolicy(ctx({
      task,
      projectWorkspace: "/home/trent/.hivewright/hives/short-stay-sales/projects/runtime-audit",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/short-stay-sales/projects/runtime-audit",
      gitBackedProject: false,
    }))).toMatchObject({ allowed: true });
  });

  it("does not let repository-neutral wording override explicit implementation requests", () => {
    for (const phrase of [
      "patch the HiveWright dashboard/API source code",
      "edit the HiveWright dashboard/API source code",
      "change the HiveWright dashboard/API source code",
      "patch the HiveWright source implementation",
      "edit the HiveWright source implementation",
      "change the implementation source",
      "do not modify unrelated code. Then patch the HiveWright dashboard/API source code",
    ] as const) {
      const task = {
        ...baseTask,
        assignedTo: "compliance-risk-analyst",
        title: "Repository-neutral HiveWright dashboard implementation",
        brief: `Repository-neutral note: do not require a git-backed project for background reading. Then ${phrase} and add Vitest tests for the route.`,
        acceptanceCriteria: "Implementation is committed with test coverage.",
      };

      expect(isCodeChangingTask(task)).toBe(true);
      const decision = evaluateTaskWorkspacePolicy(ctx({
        task,
        projectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/governance",
        baseProjectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/governance",
        gitBackedProject: false,
      }));
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toContain("no approved git-backed project_id");
      }
    }
  });

  it("does not block external business world scans that mention dashboard evidence boundaries", () => {
    const task = {
      ...baseTask,
      assignedTo: "intelligence-analyst",
      title: "Daily world scan: current external signals for Whiston Management",
      brief: "Scan current external signals that could materially affect Whiston Management. Summarize dashboard/API records only as evidence references. Do not propose HiveWright product improvements, internal platform work, provider contacts, or production changes.",
      acceptanceCriteria: "Concise external-signal summary only.",
    };

    expect(isCodeChangingTask(task)).toBe(false);
    expect(evaluateTaskWorkspacePolicy(ctx({
      task,
      projectWorkspace: "/home/trent/.hivewright/hives/whiston-management/projects/intelligence",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/whiston-management/projects/intelligence",
      gitBackedProject: false,
    }))).toMatchObject({ allowed: true });
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

  it("does not block artifact-only QA reviews that mention diagnostics metadata", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      task: {
        ...baseTask,
        assignedTo: "qa",
        title: "[QA] Review: Classify diagnostics read-path metadata exposure",
        brief: "## Git Evidence\nIsolation status: skipped\nSkipped reason: Worktree isolation disabled: task is not associated with a git-backed project.\n\n### Your Job\nReview the deliverable against the acceptance criteria. Your first non-empty line must be exactly `pass` or `fail`.",
        acceptanceCriteria: "Review the artifact only and do not modify source code.",
      },
      projectWorkspace: "/home/trent/.hivewright/hives/short-stay-sales/projects",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/short-stay-sales/projects",
      gitBackedProject: false,
    }));

    expect(decision).toMatchObject({ allowed: true });
  });

  it("does not block compliance checklist/table work that forbids implementation", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      task: {
        ...baseTask,
        assignedTo: "compliance-risk-analyst",
        title: "Build canonical OAIC/privacy remediation checklist for active micro-tools",
        brief: "Produce the Sprint 1 canonical OAIC/privacy remediation checklist/table using only internal artifacts and source references. Build one finite table with privacy surfaces, cloud/API routing, risk rating, mitigation class, owner gate status, and stop condition. Do not use live probes, do not inspect production/customer data, do not make configuration changes, do not contact vendors, and do not draft external-facing policy text. If any attribute cannot be resolved from internal evidence, mark it as unknown or defer rather than inferring. Mitigations are classified as internal-safe, implementation-later, owner-gated, or defer.",
        acceptanceCriteria: "No live probes, customer data inspection, vendor contact, or config changes occur.",
      },
      projectWorkspace: "/home/trent/.hivewright/hives/trents-personal/projects/compliance",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/trents-personal/projects/compliance",
      gitBackedProject: false,
    }));

    expect(decision).toMatchObject({ allowed: true });
  });

  it("still blocks compliance implementation work that asks for source edits", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      task: {
        ...baseTask,
        assignedTo: "compliance-risk-analyst",
        title: "Implement privacy logging fix for active micro-tools",
        brief: "Patch the dashboard API route source code and add a Vitest regression for the compliance logging bug.",
        acceptanceCriteria: "Code changes and tests are committed.",
      },
      projectWorkspace: "/home/trent/.hivewright/hives/trents-personal/projects/compliance",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/trents-personal/projects/compliance",
      gitBackedProject: false,
    }));

    expect(decision.allowed).toBe(false);
  });

  it("still blocks dev-agent dashboard/table/checklist implementation even with internal-artifact language", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      task: {
        ...baseTask,
        assignedTo: "dev-agent",
        title: "Build dashboard checklist table for internal artifacts",
        brief: "Implement the HiveWright dashboard UI table that renders internal artifacts and owner checklist state.",
        acceptanceCriteria: "Add component code and Vitest coverage.",
      },
      projectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/internal-artifacts",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/internal-artifacts",
      gitBackedProject: false,
    }));

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("no approved git-backed project_id");
    }
  });

  it("still blocks code-role QA artifact implementation when broad recovery words appear", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      task: {
        ...baseTask,
        assignedTo: "frontend-engineer",
        title: "Replan dashboard readiness artifact table",
        brief: "Fix the HiveWright dashboard source so the readiness artifact table shows QA failure re-planning status.",
        acceptanceCriteria: "Patch React component code and add tests.",
      },
      projectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/readiness",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/readiness",
      gitBackedProject: false,
    }));

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("no approved git-backed project_id");
    }
  });

  it("still blocks non-code-role HiveWright UI implementation with no-live-probe guardrails", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      task: {
        ...baseTask,
        assignedTo: "compliance-risk-analyst",
        title: "Build dashboard checklist table for internal artifacts",
        brief: "Implement the HiveWright dashboard UI table that renders internal artifacts and owner checklist state. Do not use live probes, do not inspect production/customer data, do not make configuration changes, do not contact vendors, and do not draft external-facing policy text.",
        acceptanceCriteria: "Dashboard UI implementation is covered by tests.",
      },
      projectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/internal-artifacts",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/internal-artifacts",
      gitBackedProject: false,
    }));

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("no approved git-backed project_id");
    }
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
