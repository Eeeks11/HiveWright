import { describe, expect, it } from "vitest";
import {
  ACTION_LOOP_STAGES,
  createActionLoopRun,
  completeActionLoopStage,
  type ActionLoopTemplate,
} from "./runner";

const baseTemplate: ActionLoopTemplate = {
  id: "tmpl-marketing-weekly",
  hiveId: "hive-1",
  domain: "marketing-attention",
  slug: "weekly-attention-loop",
  name: "Weekly attention loop",
  objective: "increase qualified direct-booking attention",
  stages: ACTION_LOOP_STAGES.map((stage) => ({
    stage,
    role: stage === "execute" ? "executor" : "strategist",
    requires: stage === "observe" ? [] : [ACTION_LOOP_STAGES[ACTION_LOOP_STAGES.indexOf(stage) - 1]],
    writes: [`${stage}-output`],
  })),
  successMetric: "qualified attention generated from approved campaigns",
  ownerVisibleOutputPolicy: "approval-request",
  defaultAutonomyLevel: 1,
  approvalPolicy: {
    publicActionsRequireApproval: true,
    spendActionsRequireApproval: true,
    customerFacingActionsRequireApproval: true,
  },
};

describe("operating loop runner", () => {
  it("creates a loop run with observable stage state instead of report-only schedule metadata", () => {
    const run = createActionLoopRun({
      template: baseTemplate,
      cycleKey: "2026-W25",
      inputManifest: [{ kind: "business-record", path: "marketing/profile.json" }],
    });

    expect(run.stage).toBe("observe");
    expect(run.status).toBe("queued");
    expect(run.stageState.map((stage) => stage.stage)).toEqual(ACTION_LOOP_STAGES);
    expect(run.stageState[0]).toMatchObject({ stage: "observe", status: "ready" });
    expect(run.stageState.slice(1).every((stage) => stage.status === "waiting_on_handoff")).toBe(true);
    expect(run.outputManifest).toEqual([]);
  });

  it("passes structured handoff output from each stage to the next stage", () => {
    const run = createActionLoopRun({ template: baseTemplate, cycleKey: "2026-W25" });

    const planned = completeActionLoopStage(run, {
      stage: "observe",
      structuredOutput: {
        summary: "Search impressions rose but landing-page visits fell.",
        observations: [{ metric: "visits", direction: "down" }],
      },
      outputManifest: [{ kind: "business-record", path: "marketing/observations.json" }],
    });

    expect(planned.stage).toBe("plan");
    expect(planned.stageState.find((stage) => stage.stage === "observe")?.status).toBe("completed");
    expect(planned.stageState.find((stage) => stage.stage === "plan")?.status).toBe("ready");
    expect(planned.stageState.find((stage) => stage.stage === "plan")?.handoffFrom).toEqual("observe");
    expect(planned.stageState.find((stage) => stage.stage === "plan")?.input).toMatchObject({
      summary: "Search impressions rose but landing-page visits fell.",
    });
  });

  it("refuses unsafe execution without an approval request rather than treating a report as completion", () => {
    let run = createActionLoopRun({ template: baseTemplate, cycleKey: "2026-W25" });
    run = completeActionLoopStage(run, {
      stage: "observe",
      structuredOutput: { observations: ["Attention bottleneck found"] },
    });
    run = completeActionLoopStage(run, {
      stage: "plan",
      structuredOutput: {
        actions: [
          {
            id: "publish-gbp-update",
            title: "Publish Google Business Profile update",
            risk: "public",
          },
        ],
      },
    });

    const blocked = completeActionLoopStage(run, {
      stage: "execute",
      structuredOutput: { attemptedActionId: "publish-gbp-update" },
      requestedActions: [{ id: "publish-gbp-update", risk: "public" }],
    });

    expect(blocked.status).toBe("awaiting_approval");
    expect(blocked.stage).toBe("execute");
    expect(blocked.approvalsRequired).toEqual([
      {
        actionId: "publish-gbp-update",
        risk: "public",
        reason: "public actions require owner approval",
      },
    ]);
    expect(blocked.stageState.find((stage) => stage.stage === "execute")?.status).toBe("awaiting_approval");
    expect(blocked.ownerVisibleOutput).toMatchObject({
      policy: "approval-request",
      kind: "approval_request",
    });
  });

  it("forces measure and optimise after execution so loops cannot terminate at report generation", () => {
    let run = createActionLoopRun({ template: baseTemplate, cycleKey: "2026-W25" });
    run = completeActionLoopStage(run, { stage: "observe", structuredOutput: { observations: ["Lead volume up"] } });
    run = completeActionLoopStage(run, { stage: "plan", structuredOutput: { actions: [{ id: "draft-post" }] } });
    run = completeActionLoopStage(run, {
      stage: "execute",
      structuredOutput: { executedActions: [{ id: "draft-post", type: "internal_draft" }] },
      requestedActions: [{ id: "draft-post", risk: "internal" }],
    });

    expect(run.stage).toBe("measure");
    expect(run.status).toBe("running");
    expect(run.stageState.find((stage) => stage.stage === "measure")?.status).toBe("ready");
    expect(run.stageState.find((stage) => stage.stage === "optimise")?.status).toBe("waiting_on_handoff");

    run = completeActionLoopStage(run, { stage: "measure", structuredOutput: { metrics: { leads: 12 } } });
    run = completeActionLoopStage(run, { stage: "optimise", structuredOutput: { optimiserDecision: "change", nextActions: ["rewrite offer"] } });

    expect(run.status).toBe("completed");
    expect(run.nextStage).toBe("observe");
    expect(run.optimiserDecision).toBe("change");
    expect(run.ownerVisibleOutput).toMatchObject({ kind: "weekly_summary" });
  });
});
