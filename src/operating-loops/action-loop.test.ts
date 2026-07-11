import { describe, expect, it } from "vitest";
import { ACTION_LOOP_STAGES, buildActionLoopScheduleDefinitions } from "./action-loop";

describe("buildActionLoopScheduleDefinitions", () => {
  it("creates a chained marketing attention loop instead of standalone report jobs", () => {
    const schedules = buildActionLoopScheduleDefinitions({
      hiveName: "Lakes Bushland Caravan Park",
      loopId: "lakes.marketing.attention.weekly",
      domain: "marketing-attention",
      objective: "increase qualified winter direct-booking attention",
      stateNamespace: "marketing/attention",
    });

    expect(schedules.map((schedule) => schedule.template.actionLoop.stage)).toEqual(ACTION_LOOP_STAGES);
    expect(schedules.map((schedule) => schedule.key)).toEqual([
      "lakes.marketing.attention.weekly.observe",
      "lakes.marketing.attention.weekly.plan",
      "lakes.marketing.attention.weekly.execute",
      "lakes.marketing.attention.weekly.measure",
      "lakes.marketing.attention.weekly.optimise",
    ]);

    const observe = schedules[0].template;
    expect(observe.brief).toContain("write structured observations only");
    expect(observe.brief).toContain("do not stop at a narrative report");
    expect(observe.actionLoop.writesTo).toEqual([
      { kind: "business-record", path: "marketing/attention/observations.json" },
    ]);
    expect(observe.actionLoop.nextStage).toBe("plan");

    const execute = schedules[2].template;
    expect(execute.qaRequired).toBe(true);
    expect(execute.priority).toBe(2);
    expect(execute.actionLoop.approvalMode).toBe("approval-required");
    expect(execute.actionLoop.ownerVisibleOutput).toBe("approval-request");
    expect(execute.brief).toContain("Execute only approved or bounded actions");

    const optimise = schedules[4].template;
    expect(optimise.actionLoop.nextStage).toBe("observe");
    expect(optimise.brief).toContain("kill, keep, change, or scale");
    expect(optimise.brief).toContain("rather than producing a dead-end report");
  });

  it("keeps marketing attention and sales conversion as distinct loop domains", () => {
    const marketing = buildActionLoopScheduleDefinitions({
      hiveName: "Seed Co",
      loopId: "seed.marketing.attention",
      domain: "marketing-attention",
      objective: "create and capture qualified attention",
      stateNamespace: "marketing/attention",
    });
    const sales = buildActionLoopScheduleDefinitions({
      hiveName: "Seed Co",
      loopId: "seed.sales.conversion",
      domain: "sales-conversion",
      objective: "convert leads into bookings and revenue",
      stateNamespace: "sales/conversion",
    });

    expect(marketing[0].template.actionLoop.domain).toBe("marketing-attention");
    expect(sales[0].template.actionLoop.domain).toBe("sales-conversion");
    expect(marketing[0].template.actionLoop.successMetric).toContain("attention");
    expect(sales[0].template.actionLoop.successMetric).toContain("conversion");
    expect(marketing[1].template.actionLoop.writesTo[0].path).toBe("marketing/attention/plan.json");
    expect(sales[1].template.actionLoop.writesTo[0].path).toBe("sales/conversion/plan.json");
  });
});
