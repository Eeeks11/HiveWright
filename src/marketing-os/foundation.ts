import { buildConnectorDataSources, type ConnectorSourceInput } from "@/operating-systems/connector-data-sources";

export type MarketingChannel =
  | "seo"
  | "google_business_profile"
  | "social"
  | "email"
  | "ads"
  | "partnerships"
  | "print_offline";

export type MarketingCampaignStatus = "idea" | "draft" | "approval" | "approved" | "running" | "paused" | "completed" | "killed";
export type MarketingAssetApprovalStatus = "pending_owner_approval" | "approved" | "rejected";
export type MarketingAssetPublicationStatus = "draft" | "queued" | "published" | "blocked";
export type MarketingMetricFreshness = "current" | "stale" | "missing";
export type MarketingAttributionConfidence = "manual_unverified" | "imported" | "connector_verified";

const MARKETING_STAGE_ORDER = ["observe", "plan", "execute", "measure", "optimise"] as const;
const MARKETING_SUCCESS_METRICS = [
  "impressions",
  "clicks",
  "ctr",
  "landing_page_visits",
  "cost_per_lead",
  "ad_spend_cents",
  "leads",
  "qualified_leads",
  "bookings",
  "sales",
] as const;

export type MarketingProfile = {
  id: string;
  hiveId: string;
  industry: string;
  targetCustomers: string[];
  offers: string[];
  serviceAreas: string[];
  brandVoice: string;
  forbiddenClaims: string[];
  approvalPolicy: {
    publicOrSpendActions: "owner_approval_required";
    defaultAutonomyLevel: 1 | 2;
    rationale: string;
  };
};

export type MarketingCampaign = {
  id: string;
  hiveId: string;
  domain: "marketing-attention";
  objective: string;
  targetAudience: string;
  offer: string;
  channels: MarketingChannel[];
  status: MarketingCampaignStatus;
  spendBudgetCents?: number | null;
  budgetApproval?: MarketingBudgetApproval;
  successMetrics: string[];
  createdAt: string;
};

export type MarketingBudgetApproval = {
  id: string;
  campaignId: string;
  requestedBudgetCents: number;
  approvalStatus: "approved";
  ownerId: string;
  reason?: string;
  approvedAt: string;
  policySnapshot: {
    spendCapRequired: true;
    ownerApprovalRequired: true;
    pauseOrKillRulesRequired: true;
  };
};

export type PaidCampaignPolicyDecision = {
  campaignId: string;
  rule: "keep" | "pause" | "kill";
  recommendedStatus: Extract<MarketingCampaignStatus, "running" | "paused" | "killed">;
  reasons: string[];
  metrics: {
    adSpendCents: number;
    spendBudgetCents: number;
    costPerLeadCents: number | null;
    leadQualityRate: number | null;
    leadToBookingRate: number | null;
  };
};

export type MarketingAsset = {
  id: string;
  campaignId: string;
  hiveId: string;
  channel: MarketingChannel;
  assetType: string;
  title: string;
  draftBody: string;
  approvalStatus: MarketingAssetApprovalStatus;
  publicationStatus: MarketingAssetPublicationStatus;
  scheduledFor: string;
  ownerDecision?: {
    ownerId: string;
    decision: "approved" | "rejected";
    reason?: string;
    decidedAt: string;
  };
};

export type MarketingContentCalendarEntry = {
  id: string;
  campaignId: string;
  assetId: string;
  channel: MarketingChannel;
  title: string;
  scheduledFor: string;
  status: MarketingAssetPublicationStatus;
};

export type MarketingMetricSnapshot = {
  id: string;
  campaignId: string;
  source: "manual_import" | "connector";
  connectorInstallId?: string | null;
  sourceConnector?: string | null;
  sourceStream?: string | null;
  externalId?: string | null;
  capturedAt: string;
  values: Partial<Record<(typeof MARKETING_SUCCESS_METRICS)[number], number>>;
  attributionConfidence: MarketingAttributionConfidence;
  freshness: MarketingMetricFreshness;
  trustMetadata?: Record<string, unknown>;
};

export type MarketingExecutionLog = {
  id: string;
  campaignId: string;
  assetId: string;
  action: string;
  connector: "manual" | "manual_import" | "connector";
  executedAt: string;
  trace: ["asset_drafted", "owner_approved", "execution_logged"];
};

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "marketing";
}

function stableId(...parts: string[]) {
  return parts.map((part) => slugify(part)).filter(Boolean).join("_");
}

function daysFrom(now: Date, dayOffset: number) {
  const next = new Date(now);
  next.setUTCDate(next.getUTCDate() + dayOffset);
  return next.toISOString();
}

function assetTypeForChannel(channel: MarketingChannel) {
  switch (channel) {
    case "seo":
      return "seo_content_brief";
    case "google_business_profile":
      return "google_business_profile_update";
    case "social":
      return "social_post";
    case "email":
      return "email_campaign";
    case "ads":
      return "ad_creative";
    case "partnerships":
      return "partner_pitch";
    case "print_offline":
      return "offline_flyer_brief";
  }
}

function safeRatio(numerator: number, denominator: number) {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

function metricNumber(metric: MarketingMetricSnapshot | undefined, key: (typeof MARKETING_SUCCESS_METRICS)[number]) {
  return metric?.values[key] ?? 0;
}

export function createMarketingProfile(input: {
  hiveId: string;
  industry: string;
  targetCustomers: string[];
  offers: string[];
  serviceAreas: string[];
  brandVoice: string;
  forbiddenClaims?: string[];
}): MarketingProfile {
  return {
    id: stableId("marketing-profile", input.hiveId),
    hiveId: input.hiveId,
    industry: input.industry,
    targetCustomers: input.targetCustomers,
    offers: input.offers,
    serviceAreas: input.serviceAreas,
    brandVoice: input.brandVoice,
    forbiddenClaims: input.forbiddenClaims ?? [],
    approvalPolicy: {
      publicOrSpendActions: "owner_approval_required",
      defaultAutonomyLevel: 1,
      rationale: "Marketing OS starts draft-only; publishing, spend, and customer-facing changes require owner approval.",
    },
  };
}

export function createMarketingObjectiveDraft(input: {
  hiveId: string;
  objective: string;
  targetAudience: string;
  offer: string;
  channels: MarketingChannel[];
  now?: Date;
}): {
  campaign: MarketingCampaign;
  assets: MarketingAsset[];
  contentCalendar: MarketingContentCalendarEntry[];
} {
  const now = input.now ?? new Date();
  const campaignId = stableId("marketing-campaign", input.hiveId, input.objective);
  const campaign: MarketingCampaign = {
    id: campaignId,
    hiveId: input.hiveId,
    domain: "marketing-attention",
    objective: input.objective,
    targetAudience: input.targetAudience,
    offer: input.offer,
    channels: input.channels,
    status: "draft",
    successMetrics: input.channels.includes("ads")
      ? [...MARKETING_SUCCESS_METRICS]
      : ["impressions", "clicks", "ctr", "landing_page_visits", "cost_per_lead"],
    createdAt: now.toISOString(),
  };

  const assets = input.channels.map((channel, index) => {
    const assetType = assetTypeForChannel(channel);
    return {
      id: stableId(campaignId, channel, assetType),
      campaignId,
      hiveId: input.hiveId,
      channel,
      assetType,
      title: `${input.offer} — ${channel.replaceAll("_", " ")} draft`,
      draftBody: `Draft ${assetType.replaceAll("_", " ")} for ${input.targetAudience}: ${input.objective}. Offer: ${input.offer}.`,
      approvalStatus: "pending_owner_approval" as const,
      publicationStatus: "draft" as const,
      scheduledFor: daysFrom(now, index + 1),
    } satisfies MarketingAsset;
  });

  return {
    campaign,
    assets,
    contentCalendar: assets.map((asset) => ({
      id: stableId("calendar", asset.id),
      campaignId,
      assetId: asset.id,
      channel: asset.channel,
      title: asset.title,
      scheduledFor: asset.scheduledFor,
      status: asset.publicationStatus,
    })),
  };
}

export function approveMarketingAsset(input: {
  asset: MarketingAsset;
  decision: "approved" | "rejected";
  ownerId: string;
  reason?: string;
  now?: Date;
}): MarketingAsset {
  return {
    ...input.asset,
    approvalStatus: input.decision === "approved" ? "approved" : "rejected",
    publicationStatus: input.decision === "approved" ? "queued" : "blocked",
    ownerDecision: {
      ownerId: input.ownerId,
      decision: input.decision,
      reason: input.reason,
      decidedAt: (input.now ?? new Date()).toISOString(),
    },
  };
}

export function approveMarketingBudgetChange(input: {
  campaign: MarketingCampaign;
  requestedBudgetCents: number;
  ownerId: string;
  reason?: string;
  now?: Date;
}): { campaign: MarketingCampaign; approvalStatus: "approved"; budgetApproval: MarketingBudgetApproval } {
  if (!input.campaign.channels.includes("ads")) {
    throw new Error("Marketing budget approval is only valid for paid ads campaigns.");
  }
  if (!Number.isInteger(input.requestedBudgetCents) || input.requestedBudgetCents <= 0) {
    throw new Error("Paid ads require an explicit positive budget cap in cents before spend can start.");
  }

  const approvedAt = (input.now ?? new Date()).toISOString();
  const budgetApproval: MarketingBudgetApproval = {
    id: stableId("marketing-budget-approval", input.campaign.id, String(input.requestedBudgetCents), approvedAt),
    campaignId: input.campaign.id,
    requestedBudgetCents: input.requestedBudgetCents,
    approvalStatus: "approved",
    ownerId: input.ownerId,
    reason: input.reason,
    approvedAt,
    policySnapshot: {
      spendCapRequired: true,
      ownerApprovalRequired: true,
      pauseOrKillRulesRequired: true,
    },
  };

  return {
    approvalStatus: "approved",
    budgetApproval,
    campaign: {
      ...input.campaign,
      status: "approved",
      spendBudgetCents: input.requestedBudgetCents,
      budgetApproval,
    },
  };
}

export function startPaidMarketingCampaign(input: {
  campaign: MarketingCampaign;
  budgetApproval?: MarketingBudgetApproval;
}): MarketingCampaign {
  if (!input.campaign.channels.includes("ads")) {
    throw new Error("Only paid ads campaigns can be started through the paid campaign gate.");
  }
  const approval = input.budgetApproval ?? input.campaign.budgetApproval;
  const spendBudgetCents = input.campaign.spendBudgetCents ?? approval?.requestedBudgetCents ?? null;
  if (!approval || approval.approvalStatus !== "approved" || !spendBudgetCents || spendBudgetCents <= 0) {
    throw new Error("Paid ads cannot start without an explicit owner-approved budget cap.");
  }
  if (approval.campaignId !== input.campaign.id || approval.requestedBudgetCents !== spendBudgetCents) {
    throw new Error("Paid ads budget approval must match the campaign and spend cap.");
  }

  return {
    ...input.campaign,
    status: "running",
    spendBudgetCents,
    budgetApproval: approval,
  };
}

export function evaluatePaidCampaignPolicy(input: {
  campaign: MarketingCampaign;
  metric?: MarketingMetricSnapshot;
  maxCostPerLeadCents: number;
  minLeadQualityRate: number;
  minLeadToBookingRate: number;
}): PaidCampaignPolicyDecision {
  const spendBudgetCents = input.campaign.spendBudgetCents ?? 0;
  const adSpendCents = metricNumber(input.metric, "ad_spend_cents");
  const leads = metricNumber(input.metric, "leads");
  const qualifiedLeads = metricNumber(input.metric, "qualified_leads");
  const bookings = metricNumber(input.metric, "bookings");
  const costPerLeadCents = leads > 0 ? Math.round(adSpendCents / leads) : null;
  const leadQualityRate = safeRatio(qualifiedLeads, leads);
  const leadToBookingRate = safeRatio(bookings, leads);
  const reasons: string[] = [];

  if (!spendBudgetCents || spendBudgetCents <= 0) reasons.push("Missing owner-approved paid ads budget cap.");
  if (spendBudgetCents > 0 && adSpendCents >= spendBudgetCents) reasons.push("Spend has reached the owner-approved budget cap.");
  if (costPerLeadCents !== null && costPerLeadCents > input.maxCostPerLeadCents) {
    reasons.push(`Cost per lead ${costPerLeadCents}c exceeds policy cap ${input.maxCostPerLeadCents}c.`);
  }
  if (leadQualityRate !== null && leadQualityRate < input.minLeadQualityRate) {
    reasons.push(`Lead quality rate ${leadQualityRate.toFixed(2)} is below policy minimum ${input.minLeadQualityRate}.`);
  }
  if (leadToBookingRate !== null && leadToBookingRate < input.minLeadToBookingRate) {
    reasons.push(`Downstream lead-to-booking conversion ${leadToBookingRate.toFixed(2)} is below policy minimum ${input.minLeadToBookingRate}.`);
  }

  const kill = spendBudgetCents > 0 && adSpendCents > spendBudgetCents;
  const rule: PaidCampaignPolicyDecision["rule"] = kill ? "kill" : reasons.length > 0 ? "pause" : "keep";

  return {
    campaignId: input.campaign.id,
    rule,
    recommendedStatus: rule === "keep" ? "running" : rule === "pause" ? "paused" : "killed",
    reasons: reasons.length > 0 ? reasons : ["Paid campaign is within approved spend and conversion policy."],
    metrics: { adSpendCents, spendBudgetCents, costPerLeadCents, leadQualityRate, leadToBookingRate },
  };
}

export function createMarketingExecutionLog(input: {
  asset: MarketingAsset;
  action: string;
  connector: MarketingExecutionLog["connector"];
  now?: Date;
}): MarketingExecutionLog {
  if (input.asset.approvalStatus !== "approved") {
    throw new Error("Marketing execution requires owner approval before public, spend, or customer-facing action logs are created.");
  }

  const executedAt = (input.now ?? new Date()).toISOString();
  return {
    id: stableId("marketing-execution", input.asset.id, input.action, executedAt),
    campaignId: input.asset.campaignId,
    assetId: input.asset.id,
    action: input.action,
    connector: input.connector,
    executedAt,
    trace: ["asset_drafted", "owner_approved", "execution_logged"],
  };
}

export function buildMarketingDashboardSnapshot(input: {
  campaigns: MarketingCampaign[];
  assets: MarketingAsset[];
  metrics: MarketingMetricSnapshot[];
  executionLogs: MarketingExecutionLog[];
  connectorSources?: ConnectorSourceInput[];
}) {
  const activeCampaigns = input.campaigns.filter((campaign) => ["approved", "running"].includes(campaign.status));
  const pendingApprovals = input.assets.filter((asset) => asset.approvalStatus === "pending_owner_approval");
  const approvedQueuedAssets = input.assets.filter(
    (asset) => asset.approvalStatus === "approved" && asset.publicationStatus === "queued",
  );

  const results = activeCampaigns.map((campaign) => {
    const latestMetric = input.metrics
      .filter((metric) => metric.campaignId === campaign.id)
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
    const executionCount = input.executionLogs.filter((log) => log.campaignId === campaign.id).length;
    const adSpendCents = metricNumber(latestMetric, "ad_spend_cents");
    const leads = metricNumber(latestMetric, "leads");
    const qualifiedLeads = metricNumber(latestMetric, "qualified_leads");
    const bookings = metricNumber(latestMetric, "bookings");
    const sales = metricNumber(latestMetric, "sales");
    const costPerLeadCents = leads > 0 ? Math.round(adSpendCents / leads) : null;
    const leadQualityRate = safeRatio(qualifiedLeads, leads);
    const leadToBookingRate = safeRatio(bookings, leads);
    return {
      campaignId: campaign.id,
      campaignObjective: campaign.objective,
      spendBudgetCents: campaign.spendBudgetCents ?? null,
      impressions: latestMetric?.values.impressions ?? 0,
      clicks: latestMetric?.values.clicks ?? 0,
      ctr: latestMetric?.values.ctr ?? 0,
      landingPageVisits: latestMetric?.values.landing_page_visits ?? 0,
      adSpendCents,
      costPerLeadCents,
      leadQualityRate,
      leadToBookingRate,
      downstreamConversion: {
        leads,
        qualifiedLeads,
        bookings,
        sales,
      },
      attributionConfidence: latestMetric?.attributionConfidence ?? "manual_unverified",
      freshness: latestMetric?.freshness ?? "missing",
      dataSource: latestMetric?.source ?? "manual_import",
      sourceConnector: latestMetric?.sourceConnector ?? null,
      dataTrustBoundary: latestMetric?.trustMetadata?.trustBoundary ?? "manual_or_missing_data_requires_owner_verification",
      executionCount,
    };
  });
  const contentCalendar = input.assets
    .filter((asset) => asset.scheduledFor)
    .map((asset) => ({
      id: `calendar_${asset.id}`,
      campaignId: asset.campaignId,
      assetId: asset.id,
      channel: asset.channel,
      title: asset.title,
      scheduledFor: asset.scheduledFor,
      status: asset.publicationStatus,
    }))
    .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));

  return {
    activeCampaigns,
    pendingApprovals,
    approvedQueuedAssets,
    contentCalendar,
    dataSources: buildConnectorDataSources("marketing-attention", input.connectorSources),
    results,
    loopState: {
      domain: "marketing-attention" as const,
      stageOrder: [...MARKETING_STAGE_ORDER],
      semantics: "closed-loop observe-plan-execute-measure-optimise; report-only is not the default",
    },
  };
}
