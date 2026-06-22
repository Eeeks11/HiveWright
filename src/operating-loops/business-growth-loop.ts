import { buildActionLoopScheduleDefinitions, type ActionLoopScheduleDefinition } from "./action-loop";

export type BusinessGrowthLoopBlueprint = {
  marketingAttention: ActionLoopScheduleDefinition[];
  salesConversion: ActionLoopScheduleDefinition[];
};

export function buildBusinessGrowthLoopBlueprint(input: {
  hiveName: string;
  hiveSlug: string;
  marketingObjective?: string;
  salesObjective?: string;
}): BusinessGrowthLoopBlueprint {
  return {
    marketingAttention: buildActionLoopScheduleDefinitions({
      hiveName: input.hiveName,
      loopId: `${input.hiveSlug}.marketing.attention`,
      domain: "marketing-attention",
      objective: input.marketingObjective ?? "create, capture, and direct qualified market attention",
      stateNamespace: "marketing/attention",
      cronByStage: {
        observe: "5 6 * * 1",
        plan: "20 6 * * 1",
        execute: "40 6 * * 1",
        measure: "10 7 * * 2",
        optimise: "25 7 * * 2",
      },
    }),
    salesConversion: buildActionLoopScheduleDefinitions({
      hiveName: input.hiveName,
      loopId: `${input.hiveSlug}.sales.conversion`,
      domain: "sales-conversion",
      objective: input.salesObjective ?? "convert attention and leads into bookings, revenue, reviews, referrals, and repeat business",
      stateNamespace: "sales/conversion",
      cronByStage: {
        observe: "5 8 * * 1",
        plan: "20 8 * * 1",
        execute: "40 8 * * 1",
        measure: "10 9 * * 2",
        optimise: "25 9 * * 2",
      },
    }),
  };
}
