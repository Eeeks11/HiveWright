export const HIVE_KINDS = [
  "business",
  "personal_project",
  "personal_assistant",
  "research",
  "creative",
] as const;

export type HiveKind = typeof HIVE_KINDS[number];

export const HIVE_OPERATING_MODES = [
  "exploring",
  "validating",
  "active",
  "paused",
  "completed",
  "killed",
] as const;

export type HiveOperatingMode = typeof HIVE_OPERATING_MODES[number];

export type HiveKindSetupDefaults = {
  label: string;
  descriptionLabel: string;
  descriptionPlaceholder: string;
  missionLabel: string;
  missionPlaceholder: string;
  initialGoalLabel: string;
  initialGoalPlaceholder: string;
  defaultInitialGoal: (hiveName: string) => string;
};

const hiveKindSet = new Set<string>(HIVE_KINDS);

export function isHiveKind(value: unknown): value is HiveKind {
  return typeof value === "string" && hiveKindSet.has(value);
}

export function normalizeHiveKind(value: unknown): HiveKind {
  return isHiveKind(value) ? value : "business";
}

const hiveOperatingModeSet = new Set<string>(HIVE_OPERATING_MODES);

export function isHiveOperatingMode(value: unknown): value is HiveOperatingMode {
  return typeof value === "string" && hiveOperatingModeSet.has(value);
}

export function normalizeHiveOperatingMode(value: unknown): HiveOperatingMode {
  return isHiveOperatingMode(value) ? value : "exploring";
}

export const HIVE_KIND_SETUP_DEFAULTS: Record<HiveKind, HiveKindSetupDefaults> = {
  business: {
    label: "Business",
    descriptionLabel: "Business focus",
    descriptionPlaceholder: "What does this hive sell, operate, or improve?",
    missionLabel: "Commercial objective",
    missionPlaceholder: "Make the offer, customer, revenue path, and operating boundaries clear.",
    initialGoalLabel: "First commercial goal",
    initialGoalPlaceholder: "Define the offer, first customer path, and owner approval rules.",
    defaultInitialGoal: (hiveName) =>
      `Define the first commercial operating loop for ${hiveName}: offer, target customer, revenue path, and owner approval rules.`,
  },
  personal_project: {
    label: "Personal project",
    descriptionLabel: "Project focus",
    descriptionPlaceholder: "What defined project should this hive help finish?",
    missionLabel: "Project objective",
    missionPlaceholder: "State the finished outcome, deadline, constraints, and important deliverables.",
    initialGoalLabel: "First project goal",
    initialGoalPlaceholder: "Turn the outcome into milestones, blockers, and the next useful action.",
    defaultInitialGoal: (hiveName) =>
      `Turn ${hiveName} into a delivery plan with milestones, blockers, constraints, and the next useful action.`,
  },
  personal_assistant: {
    label: "Personal assistant",
    descriptionLabel: "Assistant scope",
    descriptionPlaceholder: "What recurring or admin life tasks should this hive help manage?",
    missionLabel: "Assistant boundaries",
    missionPlaceholder: "List recurring responsibilities, sensitive-action limits, and what needs approval.",
    initialGoalLabel: "First assistant request",
    initialGoalPlaceholder: "List recurring duties, approval boundaries, and the first admin task to prepare.",
    defaultInitialGoal: (hiveName) =>
      `Set up ${hiveName} as a personal assistant: recurring duties, sensitive-action boundaries, and the first admin task to prepare.`,
  },
  research: {
    label: "Research/exploration",
    descriptionLabel: "Research focus",
    descriptionPlaceholder: "What uncertainty should this hive investigate?",
    missionLabel: "Research objective",
    missionPlaceholder: "State the core questions, source standards, confidence bar, and output format.",
    initialGoalLabel: "First research goal",
    initialGoalPlaceholder: "Frame the research question, compare credible sources, and recommend next steps.",
    defaultInitialGoal: (hiveName) =>
      `Frame the research question for ${hiveName}, compare credible sources, identify unknowns, and recommend next steps.`,
  },
  creative: {
    label: "Creative/content",
    descriptionLabel: "Creative focus",
    descriptionPlaceholder: "What assets or publishable work should this hive produce?",
    missionLabel: "Creative objective",
    missionPlaceholder: "Describe the audience, asset type, style constraints, review loop, and publishing path.",
    initialGoalLabel: "First creative goal",
    initialGoalPlaceholder: "Create the first publishable asset brief, review loop, and delivery checklist.",
    defaultInitialGoal: (hiveName) =>
      `Create the first publishable asset brief for ${hiveName}: audience, format, constraints, review loop, and delivery checklist.`,
  },
};

export function defaultInitialGoalForHiveKind(kind: HiveKind, hiveName: string): string {
  return HIVE_KIND_SETUP_DEFAULTS[kind].defaultInitialGoal(hiveName || "this hive");
}
