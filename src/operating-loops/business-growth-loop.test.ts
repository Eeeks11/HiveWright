import { describe, expect, it } from "vitest";
import { buildBusinessGrowthLoopBlueprint } from "./business-growth-loop";

describe("buildBusinessGrowthLoopBlueprint", () => {
  it("builds separate weekly marketing attention and sales conversion action loops", () => {
    const blueprint = buildBusinessGrowthLoopBlueprint({
      hiveName: "Seed Co",
      hiveSlug: "seed-co",
    });

    expect(blueprint.marketingAttention).toHaveLength(5);
    expect(blueprint.salesConversion).toHaveLength(5);

    expect(blueprint.marketingAttention[0]).toMatchObject({
      key: "seed-co.marketing.attention.observe",
      cronExpression: "5 6 * * 1",
      template: {
        actionLoop: {
          domain: "marketing-attention",
          stage: "observe",
          nextStage: "plan",
        },
      },
    });

    expect(blueprint.salesConversion[0]).toMatchObject({
      key: "seed-co.sales.conversion.observe",
      cronExpression: "5 8 * * 1",
      template: {
        actionLoop: {
          domain: "sales-conversion",
          stage: "observe",
          nextStage: "plan",
        },
      },
    });

    const allSchedules = [...blueprint.marketingAttention, ...blueprint.salesConversion];
    expect(allSchedules.every((schedule) => schedule.template.brief.includes("closed observe-plan-execute-measure-optimise workflow"))).toBe(true);
    expect(allSchedules.filter((schedule) => schedule.template.actionLoop.stage === "execute").every((schedule) => schedule.template.qaRequired)).toBe(true);
  });
});
