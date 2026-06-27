"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useHiveContext } from "@/components/hive-context";
import { generateHiveAddress } from "@/hives/address";
import { HIVE_KIND_SETUP_DEFAULTS, type HiveKind } from "@/hives/kind";

const HIVE_TYPES = ["physical", "digital", "greenfield"];
const HIVE_KIND_OPTIONS: { value: HiveKind; label: string; description: string }[] = [
  { value: "business", label: "Business", description: "make money / run commercial ops" },
  { value: "personal_project", label: "Personal project", description: "finish a defined project" },
  { value: "personal_assistant", label: "Personal assistant", description: "help manage recurring/admin life tasks" },
  { value: "research", label: "Research/exploration", description: "investigate and recommend" },
  { value: "creative", label: "Creative/content", description: "produce assets and publishable work" },
];
const SETUP_WELCOME_DISMISSED_KEY = "hivewright.setupWelcomeDismissed";

const WELCOME_CONCEPTS = [
  {
    term: "HiveWright",
    description: "HiveWright is the operating system for your hive: the business, project, or life area you want help running. It keeps the work moving and brings you in when your judgement is needed.",
  },
  {
    term: "EA",
    description: "Your EA is the front door for the hive. It helps you give direction, ask questions, and keep track of what is happening.",
  },
  {
    term: "Agents",
    description: "Agents are specialist workers that take on tasks for the hive. They research, build, check, and report back based on the mission you set.",
  },
  {
    term: "Dispatcher",
    description: "The dispatcher is the work coordinator. It decides which agent should handle each task and keeps the queue moving.",
  },
  {
    term: "Decisions",
    description: "Decisions are the moments where HiveWright needs your call. You approve, reject, or guide the next move so the hive stays aligned with you.",
  },
  {
    term: "Connectors",
    description: "Connectors let HiveWright work with services you already use, such as chat, email, repositories, and other tools. You can add them now or later.",
  },
  {
    term: "Schedules",
    description: "Schedules are recurring checks or jobs. They let the hive review things on a rhythm without waiting for you to remember.",
  },
  {
    term: "Memory",
    description: "Memory is what HiveWright learns about your hive over time. It helps future work start with the right context instead of starting from scratch.",
  },
];

const AUTO_MODEL_ROUTE = "auto";

const ADAPTER_GROUPS = [
  {
    label: "HiveWright managed routing",
    adapters: [
      {
        value: AUTO_MODEL_ROUTE,
        label: "Auto Routing",
        description: "HiveWright chooses the best enabled, healthy model for each task using the model routing policy.",
      },
    ],
  },
  {
    label: "Owner-managed CLI runtimes",
    adapters: [
      {
        value: "codex",
        label: "Codex",
        description: "Runs agents through the Codex CLI using the owner's Codex or ChatGPT authentication.",
      },
      {
        value: "claude-code",
        label: "Claude Code",
        description: "Runs agents through the Claude Code CLI using the owner's signed-in CLI session.",
      },
      {
        value: "gemini",
        label: "Gemini CLI",
        description: "Runs agents through Google's Gemini CLI.",
      },
    ],
  },
  {
    label: "Local or self-hosted runtimes",
    adapters: [
      {
        value: "ollama",
        label: "Ollama",
        description: "Runs agents against local models exposed by Ollama.",
      },
    ],
  },
];

const ADAPTER_LABELS = Object.fromEntries(
  ADAPTER_GROUPS.flatMap((group) => group.adapters.map((adapter) => [adapter.value, adapter.label])),
) as Record<string, string>;

const RUNTIME_PRESETS = [
  {
    value: AUTO_MODEL_ROUTE,
    label: "Auto Routing (recommended)",
    description: "Use HiveWright's Auto routing system: pick the best enabled, healthy model per task based on capability, cost, and routing policy.",
  },
  {
    value: "codex",
    label: "Codex CLI",
    description: "Force every worker to use the local Codex session. Use this only when you specifically want Codex for all roles.",
  },
  {
    value: "claude-code",
    label: "Claude Code",
    description: "Force every worker to use the local Claude Code session. Use this only when Claude Code is preferred for all roles.",
  },
  {
    value: "gemini",
    label: "Gemini CLI",
    description: "Use this when your local Gemini CLI session is the preferred way to run workers.",
  },
  {
    value: "ollama",
    label: "Local models",
    description: "Use this when workers should run through a local model service you manage.",
  },
];

const ANTHROPIC_MODELS = [
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-7",
  "anthropic/claude-opus-4-6",
];
const CODEX_MODELS = [
  "openai-codex/gpt-5.5",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.4-mini",
];
const GEMINI_MODELS = [
  "google/gemini-2.5-pro",
  "google/gemini-2.5-flash",
];
const GENERAL_MODELS = [
  ...ANTHROPIC_MODELS,
  ...CODEX_MODELS,
  "mistral/mistral-large-latest",
  "mistral/mistral-ocr-latest",
  "openai/gpt-5.5",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  ...GEMINI_MODELS,
];

const EA_DISCORD_CONNECTOR_SLUG = "ea-discord";
const DISCORD_BOT_INVITE_PERMISSIONS = "274877908992";
const REVIEW_STEP = 7;
const PROJECTS_STEP = 6;

type RequestSortingPreset = "balanced" | "direct" | "goals";
type SafetyPreset = "open" | "owner_review_first" | "locked_down" | "custom";
type BusinessMode = "new_business" | "existing_business";

const BUSINESS_MODE_OPTIONS: { value: BusinessMode; label: string; description: string }[] = [
  {
    value: "new_business",
    label: "New business — set up a new operating model",
    description: "Use HiveWright to turn an idea or opportunity into structured setup state, launch gaps, and approval-gated first actions.",
  },
  {
    value: "existing_business",
    label: "Existing business — audit and improve current operations",
    description: "Use HiveWright to assess the current business, find operating gaps, and queue governed improvement actions.",
  },
];

interface ProjectEntry {
  name: string;
  slug: string;
  workspacePath: string;
  gitRepo: boolean;
}

interface SetupField {
  key: string;
  label: string;
  placeholder?: string;
  helpText?: string;
  type?: "text" | "url" | "password" | "textarea";
  required?: boolean;
}

interface Connector {
  slug: string;
  name: string;
  category: string;
  description: string;
  icon: string | null;
  authType: "api_key" | "oauth2" | "webhook" | "none";
  setupFields: SetupField[];
  scopes?: { key: string; kind?: string; required?: boolean }[];
  operations: { slug: string; label: string }[];
  requiresDispatcherRestart?: boolean;
}

interface Role {
  slug: string;
  name: string;
  department: string;
  adapterType: string;
  recommendedModel: string;
}

interface WizardState {
  kind: HiveKind;
  businessMode: BusinessMode;
  newBusinessSetup: {
    idea: string;
    feasibilityRisks: string;
    customerSegments: string;
    problemStatements: string;
    offers: string;
    pricingModel: string;
    businessBlueprint: string;
    marketingModel: string;
    salesModel: string;
    deliveryModel: string;
    adminFinanceModel: string;
    legalComplianceChecklist: string;
    toolStack: string;
    rolesAndSops: string;
    launchReadiness: string;
    launchRoadmap: string;
    launchActions: string;
    initialLoops: string;
  };
  name: string;
  slug: string;
  type: string;
  description: string;
  mission: string;
  initialGoal: string;
  roleOverrides: Record<string, { adapter?: string; model?: string }>;
  connectorSelections: Record<string, "skipped" | "configure-later" | "configured">;
  connectorDisplayNames: Record<string, string>;
  connectorFields: Record<string, Record<string, string>>;
  projects: ProjectEntry[];
  operatingPreferences: {
    maxConcurrentAgents: number;
    proactiveWork: boolean;
    memorySearch: boolean;
    requestSorting: RequestSortingPreset;
  };
  safetyPreset: SafetyPreset;
}

type RuntimeStatus = "ready" | "check_required" | "missing";

interface RuntimeReadiness {
  label: string;
  installed: boolean;
  status: RuntimeStatus;
  detail: string;
  nextStep: string;
}

interface SetupReadiness {
  checkedAt: string;
  runtimes: Record<string, RuntimeReadiness>;
}

interface LocalEmbeddingSetupStatus {
  ollamaReachable: boolean;
  modelInstalled: boolean;
  embeddingTest: "not_run" | "passed" | "failed";
  modelName: string;
  error: string | null;
}

interface LocalEmbeddingSetup {
  status: LocalEmbeddingSetupStatus;
  defaultConfig: {
    provider: string;
    modelName: string;
    dimension: number;
    endpointOverride: string;
  };
}

interface InstalledConnectorSetupResult {
  id: string;
  connectorSlug: string;
  displayName: string;
  requiresDispatcherRestart: boolean;
  hasSafeTest: boolean;
}

function defaultGrantedScopesForSetup(connector: Connector) {
  return (connector.scopes ?? [])
    .filter((scope) => scope.required === true || scope.kind === "send")
    .map((scope) => scope.key);
}

function discordBotInviteUrl(applicationId: string) {
  const trimmed = applicationId.trim();
  if (!trimmed) return null;
  const params = new URLSearchParams({
    client_id: trimmed,
    permissions: DISCORD_BOT_INVITE_PERMISSIONS,
    scope: "bot applications.commands",
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export default function NewHiveWizard() {
  const router = useRouter();
  const { refreshHives: contextRefreshHives } = useHiveContext();
  const refreshHives = contextRefreshHives ?? (async () => {});
  const [showWelcome, setShowWelcome] = useState<boolean | null>(null);
  const [step, setStep] = useState(1);
  const [roles, setRoles] = useState<Role[]>([]);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [connectorsLoading, setConnectorsLoading] = useState(true);
  const [connectorsError, setConnectorsError] = useState<string | null>(null);
  const [expandedConnector, setExpandedConnector] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupStatus, setSetupStatus] = useState<string | null>(null);
  const [customAddressEdited, setCustomAddressEdited] = useState(false);
  const [runtimeAdvancedOpen, setRuntimeAdvancedOpen] = useState(false);
  const [projectAdvancedOpen, setProjectAdvancedOpen] = useState<Record<number, boolean>>({});
  const [setupReadiness, setSetupReadiness] = useState<SetupReadiness | null>(null);
  const [setupReadinessLoading, setSetupReadinessLoading] = useState(false);
  const [setupReadinessError, setSetupReadinessError] = useState<string | null>(null);
  const [embeddingSetup, setEmbeddingSetup] = useState<LocalEmbeddingSetup | null>(null);
  const [embeddingSetupLoading, setEmbeddingSetupLoading] = useState(false);
  const [embeddingSetupError, setEmbeddingSetupError] = useState<string | null>(null);
  const [embeddingSetupAction, setEmbeddingSetupAction] = useState<string | null>(null);

  const [state, setState] = useState<WizardState>({
    kind: "business",
    businessMode: "new_business",
    newBusinessSetup: {
      idea: "",
      feasibilityRisks: "",
      customerSegments: "",
      problemStatements: "",
      offers: "",
      pricingModel: "",
      businessBlueprint: "",
      marketingModel: "",
      salesModel: "",
      deliveryModel: "",
      adminFinanceModel: "",
      legalComplianceChecklist: "",
      toolStack: "",
      rolesAndSops: "",
      launchReadiness: "",
      launchRoadmap: "",
      launchActions: "",
      initialLoops: "",
    },
    name: "",
    slug: "",
    type: "digital",
    description: "",
    mission: "",
    initialGoal: "",
    roleOverrides: {},
    connectorSelections: {},
    connectorDisplayNames: {},
    connectorFields: {},
    projects: [],
    operatingPreferences: {
      maxConcurrentAgents: 3,
      proactiveWork: true,
      memorySearch: true,
      requestSorting: "balanced",
    },
    safetyPreset: "owner_review_first",
  });

  const hasProjectsStep = state.type !== "physical";
  const totalSteps = hasProjectsStep ? REVIEW_STEP : REVIEW_STEP - 1;
  const displayStep = hasProjectsStep || step < REVIEW_STEP ? step : REVIEW_STEP - 1;
  const isLastStep = step === REVIEW_STEP;
  const isFirstStep = step === 1;
  const hiveAddress = state.slug || generateHiveAddress(state.name);
  const kindDefaults = HIVE_KIND_SETUP_DEFAULTS[state.kind];
  const eaDiscordConnector = connectors.find((connector) => connector.slug === EA_DISCORD_CONNECTOR_SLUG) ?? null;
  const serviceConnectors = useMemo(
    () => connectors.filter((connector) => connector.slug !== EA_DISCORD_CONNECTOR_SLUG),
    [connectors],
  );

  const update = (partial: Partial<WizardState>) => setState((prev) => ({ ...prev, ...partial }));
  const autoSlug = generateHiveAddress;
  const updateOperatingPreferences = (partial: Partial<WizardState["operatingPreferences"]>) => {
    setState((prev) => ({
      ...prev,
      operatingPreferences: { ...prev.operatingPreferences, ...partial },
    }));
  };
  const updateNewBusinessSetup = (partial: Partial<WizardState["newBusinessSetup"]>) => {
    setState((prev) => ({
      ...prev,
      newBusinessSetup: { ...prev.newBusinessSetup, ...partial },
    }));
  };

  useEffect(() => {
    setShowWelcome(localStorage.getItem(SETUP_WELCOME_DISMISSED_KEY) !== "true");
  }, []);

  const continueFromWelcome = () => {
    localStorage.setItem(SETUP_WELCOME_DISMISSED_KEY, "true");
    setShowWelcome(false);
  };

  const updateHiveName = (name: string) => {
    setState((prev) => ({
      ...prev,
      name,
      slug: customAddressEdited ? prev.slug : autoSlug(name),
    }));
  };

  const updateHiveAddress = (value: string) => {
    setCustomAddressEdited(true);
    update({ slug: autoSlug(value) });
  };

  const loadConnectors = () => {
    setConnectorsLoading(true);
    setConnectorsError(null);
    fetch("/api/connectors")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((body) => setConnectors(body.data ?? []))
      .catch((err) => {
        setConnectors([]);
        setConnectorsError(`Connector catalog could not be loaded: ${(err as Error).message}`);
      })
      .finally(() => setConnectorsLoading(false));
  };

  const loadSetupReadiness = () => {
    setSetupReadinessLoading(true);
    setSetupReadinessError(null);
    fetch("/api/setup-readiness")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((body) => setSetupReadiness(body.data ?? null))
      .catch((err) => {
        setSetupReadiness(null);
        setSetupReadinessError(`Runtime readiness could not be checked: ${(err as Error).message}`);
      })
      .finally(() => setSetupReadinessLoading(false));
  };

  const loadEmbeddingSetup = () => {
    setEmbeddingSetupLoading(true);
    setEmbeddingSetupError(null);
    fetch("/api/embedding-config/local-setup")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((body) => setEmbeddingSetup(body.data ?? null))
      .catch((err) => {
        setEmbeddingSetup(null);
        setEmbeddingSetupError(`Memory setup could not be checked: ${(err as Error).message}`);
      })
      .finally(() => setEmbeddingSetupLoading(false));
  };

  const runEmbeddingSetupAction = async (action: "install" | "pull" | "use") => {
    const messages = {
      install: "Installing Ollama...",
      pull: "Pulling the local memory model...",
      use: "Saving local memory engine...",
    };
    const successMessages = {
      install: "Ollama install started. Refresh the check when it finishes.",
      pull: "Local memory model is installed.",
      use: "Local memory engine saved. HiveWright will re-index memory in the background.",
    };
    const endpoint = action === "install"
      ? "/api/embedding-config/local-setup/install-ollama"
      : action === "pull"
        ? "/api/embedding-config/local-setup/pull-model"
        : "/api/embedding-config/local-setup/use";

    setEmbeddingSetupAction(messages[action]);
    setEmbeddingSetupError(null);
    try {
      const init: RequestInit = { method: "POST" };
      if (action === "install") {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify({ confirmed: true });
      }
      if (action === "pull") {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify({ modelName: embeddingSetup?.defaultConfig.modelName });
      }
      const res = await fetch(endpoint, init);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Local memory setup action failed.");
      setEmbeddingSetupAction(successMessages[action]);
      loadEmbeddingSetup();
    } catch (err) {
      setEmbeddingSetupAction(null);
      setEmbeddingSetupError(err instanceof Error ? err.message : "Local memory setup action failed.");
    }
  };

  const useLocalEmbeddingSetup = () => runEmbeddingSetupAction("use");

  useEffect(() => {
    fetch("/api/roles/global")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((body) => setRoles(body.data || []))
      .catch((err) => setRolesError(`Role defaults could not be loaded: ${(err as Error).message}`));

    loadConnectors();
    loadSetupReadiness();
    loadEmbeddingSetup();
  }, []);

  const connectorsByCategory = useMemo(() => {
    const grouped: Record<string, Connector[]> = {};
    for (const connector of serviceConnectors) {
      (grouped[connector.category] ||= []).push(connector);
    }
    return grouped;
  }, [serviceConnectors]);

  const recommendedConnectors = useMemo(() => {
    const preferred = ["discord-webhook", "github-pat", "gmail"];
    const seen = new Set<string>();
    const picked = preferred
      .map((slug) => serviceConnectors.find((connector) => connector.slug === slug))
      .filter((connector): connector is Connector => Boolean(connector));
    for (const connector of picked) seen.add(connector.slug);
    return [...picked, ...serviceConnectors.filter((connector) => !seen.has(connector.slug)).slice(0, Math.max(0, 6 - picked.length))];
  }, [serviceConnectors]);

  const runtimePresetIsAuto = Object.keys(state.roleOverrides).length === 0 || roles.every((role) => {
    const override = state.roleOverrides[role.slug];
    return override?.adapter === AUTO_MODEL_ROUTE && override?.model === AUTO_MODEL_ROUTE;
  });
  const getSelectedAdapter = (role: Role) => state.roleOverrides[role.slug]?.adapter ?? normalizeAdapter(role.adapterType);
  const getSelectedModel = (role: Role) => state.roleOverrides[role.slug]?.model ?? role.recommendedModel;
  const selectedRuntimeAdapters = useMemo(() => {
    if (runtimePresetIsAuto) return [AUTO_MODEL_ROUTE];
    if (roles.length === 0) return ["codex"];
    return Array.from(
      new Set(
        roles.map((role) => state.roleOverrides[role.slug]?.adapter ?? normalizeAdapter(role.adapterType)),
      ),
    );
  }, [roles, runtimePresetIsAuto, state.roleOverrides]);

  const pendingOAuthConnectors = useMemo(
    () => connectors.filter((connector) => connector.authType === "oauth2" && state.connectorSelections[connector.slug] === "configure-later"),
    [connectors, state.connectorSelections],
  );

  const launchBlockingIssues = useMemo(() => {
    const issues: string[] = [];
    if (!state.name.trim()) issues.push("Hive name is required.");
    if (!setupReadiness) {
      issues.push("Runtime readiness has not been checked yet.");
    } else {
      for (const adapter of selectedRuntimeAdapters) {
        if (adapter === AUTO_MODEL_ROUTE) continue;
        const runtime = setupReadiness.runtimes[adapter];
        if (!runtime || runtime.status === "missing") {
          issues.push(`${ADAPTER_LABELS[adapter] ?? adapter} is not installed or reachable on this server.`);
        } else if (runtime.status === "check_required") {
          issues.push(`${runtime.label} is installed, but HiveWright has not proven the signed-in session can run workers yet.`);
        }
      }
    }
    if (state.operatingPreferences.memorySearch && (!embeddingSetup || embeddingSetup.status?.embeddingTest !== "passed")) {
      issues.push("Memory search is enabled, but the local memory engine has not passed its embedding test.");
    }
    for (const connector of connectors) {
      if (state.connectorSelections[connector.slug] !== "configured") continue;
      const fields = state.connectorFields[connector.slug] ?? {};
      const missingField = connector.setupFields.find((field) => field.required && !fields[field.key]);
      if (missingField) issues.push(`${connector.name} is selected but ${missingField.label} is missing.`);
    }
    return issues;
  }, [connectors, embeddingSetup, selectedRuntimeAdapters, setupReadiness, state.connectorFields, state.connectorSelections, state.name, state.operatingPreferences.memorySearch]);

  const modelsForAdapter = (adapter: string) => {
    switch (adapter) {
      case AUTO_MODEL_ROUTE:
        return [AUTO_MODEL_ROUTE];
      case "claude-code":
        return ANTHROPIC_MODELS;
      case "codex":
        return CODEX_MODELS;
      case "gemini":
        return GEMINI_MODELS;
      default:
        return GENERAL_MODELS;
    }
  };

  const setRoleOverride = (role: Role, field: "adapter" | "model", value: string) => {
    setState((prev) => {
      const next = { ...prev.roleOverrides[role.slug], [field]: value };
      if (field === "adapter") {
        const models = modelsForAdapter(value);
        if (!models.includes(next.model ?? role.recommendedModel)) {
          next.model = models[0];
        }
      }
      return {
        ...prev,
        roleOverrides: { ...prev.roleOverrides, [role.slug]: next },
      };
    });
  };

  const applyAdapterToAllRoles = (adapter: string) => {
    setState((prev) => {
      const next = { ...prev.roleOverrides };
      for (const role of roles) {
        const models = modelsForAdapter(adapter);
        next[role.slug] = {
          ...next[role.slug],
          adapter,
          model: models.includes(next[role.slug]?.model ?? role.recommendedModel)
            ? next[role.slug]?.model ?? role.recommendedModel
            : models[0],
        };
      }
      return { ...prev, roleOverrides: next };
    });
  };

  const selectRuntimePreset = (adapter: string) => {
    if (adapter === AUTO_MODEL_ROUTE) {
      setState((prev) => ({ ...prev, roleOverrides: {} }));
      return;
    }
    applyAdapterToAllRoles(adapter);
  };

  const selectConnector = (slug: string, selection: "skipped" | "configure-later" | "configured") => {
    setState((prev) => ({
      ...prev,
      connectorSelections: { ...prev.connectorSelections, [slug]: selection },
    }));
  };

  const updateConnectorField = (slug: string, key: string, value: string) => {
    setState((prev) => ({
      ...prev,
      connectorFields: {
        ...prev.connectorFields,
        [slug]: { ...prev.connectorFields[slug], [key]: value },
      },
    }));
  };

  const updateConnectorDisplayName = (slug: string, value: string) => {
    setState((prev) => ({
      ...prev,
      connectorDisplayNames: { ...prev.connectorDisplayNames, [slug]: value },
    }));
  };

  const addProject = () => {
    setState((prev) => ({
      ...prev,
      projects: [...prev.projects, { name: "", slug: "", workspacePath: "", gitRepo: false }],
    }));
  };

  const updateProject = (index: number, field: keyof ProjectEntry, value: string | boolean) => {
    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((project, i) => {
        if (i !== index) return project;
        const updated = { ...project, [field]: value };
        if (field === "name" && typeof value === "string" && !project.slug) updated.slug = autoSlug(value);
        return updated;
      }),
    }));
  };

  const removeProject = (index: number) => {
    setState((prev) => ({
      ...prev,
      projects: prev.projects.filter((_, i) => i !== index),
    }));
    setProjectAdvancedOpen((prev) => {
      const next: Record<number, boolean> = {};
      Object.entries(prev).forEach(([key, value]) => {
        const numericKey = Number(key);
        if (numericKey < index) next[numericKey] = value;
        if (numericKey > index) next[numericKey - 1] = value;
      });
      return next;
    });
  };

  const goNext = () => {
    if (!hasProjectsStep && step === PROJECTS_STEP - 1) setStep(REVIEW_STEP);
    else setStep((s) => s + 1);
  };

  const goBack = () => {
    if (!hasProjectsStep && step === REVIEW_STEP) setStep(PROJECTS_STEP - 1);
    else setStep((s) => s - 1);
  };

  const roleOverridesForSubmit = () => {
    if (runtimePresetIsAuto) {
      return Object.fromEntries(
        roles.map((role) => [
          role.slug,
          {
            adapterType: AUTO_MODEL_ROUTE,
            recommendedModel: AUTO_MODEL_ROUTE,
          },
        ]),
      );
    }

    return Object.fromEntries(
      Object.entries(state.roleOverrides)
        .filter(([, override]) => override.adapter || override.model)
        .map(([slug, override]) => [
          slug,
          {
            adapterType: override.adapter,
            recommendedModel: override.model,
          },
        ]),
    );
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    setSetupStatus("Setting up your hive...");
    try {
      if (launchBlockingIssues.length > 0) {
        throw new Error(`Setup is not ready to launch: ${launchBlockingIssues.join(" ")}`);
      }

      const configuredConnectors = connectors
        .filter((connector) => state.connectorSelections[connector.slug] === "configured" && connector.authType !== "oauth2")
        .map((connector) => ({
          connectorSlug: connector.slug,
          displayName: state.connectorDisplayNames[connector.slug] || connector.name,
          fields: state.connectorFields[connector.slug] ?? {},
          grantedScopes: defaultGrantedScopesForSetup(connector),
        }));

      const setupRes = await fetch("/api/hives/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hive: {
            name: state.name,
            slug: hiveAddress,
            type: state.type,
            kind: state.kind,
            description: state.description,
            mission: state.mission,
          },
          roleOverrides: roleOverridesForSubmit(),
          businessOs: state.kind === "business"
            ? {
              mode: state.businessMode,
              profile: {
                businessName: state.name,
                summary: state.description,
                sourceProfile: { setupWizard: true },
              },
              setup: state.businessMode === "new_business"
                ? {
                  idea: state.newBusinessSetup.idea || state.description || state.mission,
                  feasibilityRisks: textAreaList(state.newBusinessSetup.feasibilityRisks),
                  customerSegments: textAreaList(state.newBusinessSetup.customerSegments),
                  problemStatements: textAreaList(state.newBusinessSetup.problemStatements),
                  offers: textAreaList(state.newBusinessSetup.offers),
                  pricingModel: textAreaNotes("pricing", state.newBusinessSetup.pricingModel),
                  businessBlueprint: textAreaNotes("notes", state.newBusinessSetup.businessBlueprint),
                  marketingModel: textAreaNotes("channels", state.newBusinessSetup.marketingModel),
                  salesModel: textAreaNotes("motion", state.newBusinessSetup.salesModel),
                  deliveryModel: textAreaNotes("fulfilment", state.newBusinessSetup.deliveryModel),
                  adminFinanceModel: textAreaNotes("baseline", state.newBusinessSetup.adminFinanceModel),
                  legalComplianceChecklist: textAreaList(state.newBusinessSetup.legalComplianceChecklist),
                  toolStack: textAreaList(state.newBusinessSetup.toolStack),
                  rolesAndSops: textAreaList(state.newBusinessSetup.rolesAndSops),
                  launchReadiness: textAreaList(state.newBusinessSetup.launchReadiness),
                  launchRoadmap: textAreaList(state.newBusinessSetup.launchRoadmap),
                  launchActions: textAreaList(state.newBusinessSetup.launchActions),
                  initialLoops: textAreaList(state.newBusinessSetup.initialLoops),
                }
                : undefined,
            }
            : undefined,
          connectors: configuredConnectors,
          projects: state.projects
            .filter((project) => project.name || project.slug || project.workspacePath)
            .map((project) => ({
              name: project.name,
              slug: project.slug,
              workspacePath: project.workspacePath || undefined,
              gitRepo: project.gitRepo,
            })),
          initialGoal: state.initialGoal || undefined,
          operatingPreferences: state.operatingPreferences,
          safetyPreset: state.safetyPreset,
        }),
      });
      const setupBody = await setupRes.json();
      if (!setupRes.ok) throw new Error(setupBody.error || "Hive setup did not finish. Please try again.");
      const hiveId = setupBody.data.id;
      const installedConnectors = (setupBody.data.installedConnectors ?? []) as InstalledConnectorSetupResult[];

      localStorage.setItem("selectedHiveId", hiveId);
      await refreshHives(hiveId);

      const testedConnectors = installedConnectors.filter((connector) => connector.hasSafeTest).length;
      if (testedConnectors > 0) {
        setSetupStatus(`${testedConnectors} connected service${testedConnectors === 1 ? "" : "s"} passed setup testing.`);
      }

      if (installedConnectors.some((connector) => connector.requiresDispatcherRestart)) {
        setSetupStatus("Activating connector listeners...");
        const restartRes = await fetch("/api/dispatcher/restart", { method: "POST" });
        const restartBody = await restartRes.json().catch(() => ({}));
        if (!restartRes.ok) {
          throw new Error(restartBody.error || "HiveWright could not activate connector listeners.");
        }
      }

      if (pendingOAuthConnectors.length > 0) {
        const [firstOAuth, ...remainingOAuth] = pendingOAuthConnectors;
        const redirectTo = `/settings/connectors?postSetup=1${remainingOAuth.length > 0 ? `&pendingOAuth=${encodeURIComponent(remainingOAuth.map((connector) => connector.slug).join(","))}` : ""}`;
        window.location.href = `/api/oauth/${firstOAuth.slug}/start?hiveId=${encodeURIComponent(hiveId)}&displayName=${encodeURIComponent(state.connectorDisplayNames[firstOAuth.slug] || firstOAuth.name)}&redirectTo=${encodeURIComponent(redirectTo)}`;
        return;
      }

      router.push(`/hives/${hiveId}`);
    } catch (err: unknown) {
      setSetupStatus(null);
      setError(err instanceof Error ? err.message : "Hive setup did not finish. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (showWelcome === null) {
    return null;
  }

  if (showWelcome) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <section className="space-y-6 rounded-lg border p-5 sm:p-6" aria-labelledby="setup-welcome-title">
          <div className="space-y-2">
            <p className="text-sm font-medium text-zinc-500">Hive setup</p>
            <h1 id="setup-welcome-title" className="text-2xl font-semibold">Before you create your hive</h1>
            <p className="max-w-2xl text-sm leading-6 text-zinc-600 dark:text-zinc-300">
              This setup will ask for the basics HiveWright needs to start running work for you. These are the ideas you will see during setup and while the hive operates.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {WELCOME_CONCEPTS.map((concept) => (
              <div key={concept.term} className="rounded-md border bg-zinc-50 p-4 dark:bg-zinc-900">
                <h2 className="text-sm font-semibold">{concept.term}</h2>
                <p className="mt-1 text-sm leading-6 text-zinc-600 dark:text-zinc-300">{concept.description}</p>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-zinc-500">You will only see this introduction once in this browser.</p>
            <button
              type="button"
              onClick={continueFromWelcome}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Continue to setup
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Create a Hive</h1>
        <p className="text-sm text-zinc-500">Step {displayStep} of {totalSteps}</p>
      </div>

      <div className="flex gap-1" aria-label="Wizard progress">
        {Array.from({ length: totalSteps }, (_, index) => index + 1).map((s) => (
          <div
            key={s}
            className={`h-1.5 flex-1 rounded-full ${s <= displayStep ? "bg-zinc-900 dark:bg-zinc-100" : "bg-zinc-200 dark:bg-zinc-800"}`}
          />
        ))}
      </div>

      {step === 1 && (
        <section className="space-y-4 rounded-lg border p-6" aria-labelledby="hive-step-title">
          <div>
            <h2 id="hive-step-title" className="text-lg font-medium">Create a Hive</h2>
            <p className="text-sm text-zinc-500">Give HiveWright the operating context agents will use when they plan and act.</p>
          </div>
          <div className="space-y-3">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">What kind of hive are you creating?</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {HIVE_KIND_OPTIONS.map((option) => (
                  <RadioChoice
                    key={option.value}
                    name="hive-kind"
                    checked={state.kind === option.value}
                    onChange={() => update({ kind: option.value })}
                    title={`${option.label} — ${option.description}`}
                    description={HIVE_KIND_SETUP_DEFAULTS[option.value].initialGoalPlaceholder}
                  />
                ))}
              </div>
            </fieldset>
            {state.kind === "business" && (
              <fieldset className="space-y-2" aria-label="Business OS mode">
                <legend className="text-sm font-medium">Business OS mode</legend>
                <p className="text-xs leading-5 text-zinc-500">
                  Choose whether this business hive should start by setting up a new operating model or auditing an existing one.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {BUSINESS_MODE_OPTIONS.map((option) => (
                    <RadioChoice
                      key={option.value}
                      name="business-os-mode"
                      checked={state.businessMode === option.value}
                      onChange={() => update({ businessMode: option.value })}
                      title={option.label}
                      description={option.description}
                    />
                  ))}
                </div>
              </fieldset>
            )}
            {state.kind === "business" && state.businessMode === "new_business" && (
              <div className="space-y-3 rounded-md border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/30" aria-label="New-business setup intake">
                <div>
                  <p className="text-sm font-medium text-blue-950 dark:text-blue-100">New-business setup path</p>
                  <p className="mt-1 text-xs leading-5 text-blue-900 dark:text-blue-200">
                    Capture enough context for HiveWright to create structured setup state, launch readiness, gaps, and an approval-gated action queue. You can leave unknowns blank and refine them later.
                  </p>
                </div>
                <NewBusinessStage title="1. Idea capture" description="Name the opportunity, first customer, problem, and offer assumptions.">
                  <div>
                    <label htmlFor="new-business-idea" className="text-sm font-medium">Business idea or opportunity</label>
                    <textarea
                      id="new-business-idea"
                      value={state.newBusinessSetup.idea}
                      onChange={(e) => updateNewBusinessSetup({ idea: e.target.value })}
                      rows={2}
                      placeholder="What are you trying to launch?"
                      className="mt-1 w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
                    />
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <NewBusinessTextarea
                      id="new-business-customers"
                      label="Target customers"
                      value={state.newBusinessSetup.customerSegments}
                      onChange={(value) => updateNewBusinessSetup({ customerSegments: value })}
                      placeholder="One segment per line"
                    />
                    <NewBusinessTextarea
                      id="new-business-problems"
                      label="Customer problems or triggers"
                      value={state.newBusinessSetup.problemStatements}
                      onChange={(value) => updateNewBusinessSetup({ problemStatements: value })}
                      placeholder="What pain/trigger makes them buy?"
                    />
                    <NewBusinessTextarea
                      id="new-business-offers"
                      label="Offer hypotheses"
                      value={state.newBusinessSetup.offers}
                      onChange={(value) => updateNewBusinessSetup({ offers: value })}
                      placeholder="Offer/package ideas"
                    />
                    <NewBusinessTextarea
                      id="new-business-pricing"
                      label="Pricing or margin assumptions"
                      value={state.newBusinessSetup.pricingModel}
                      onChange={(value) => updateNewBusinessSetup({ pricingModel: value })}
                      placeholder="Price, margin, capacity notes"
                    />
                  </div>
                </NewBusinessStage>
                <NewBusinessStage title="2. Feasibility and risk" description="Capture what could make the idea invalid, unsafe, illegal, or not worth launching.">
                  <NewBusinessTextarea
                    id="new-business-feasibility-risks"
                    label="Feasibility and risk notes"
                    value={state.newBusinessSetup.feasibilityRisks}
                    onChange={(value) => updateNewBusinessSetup({ feasibilityRisks: value })}
                    placeholder="Risks, assumptions to prove, constraints, compliance unknowns"
                  />
                </NewBusinessStage>
                <NewBusinessStage title="3. Business blueprint" description="Turn the idea into a structured offer/customer/pricing operating blueprint.">
                  <NewBusinessTextarea
                    id="new-business-blueprint"
                    label="Business blueprint"
                    value={state.newBusinessSetup.businessBlueprint}
                    onChange={(value) => updateNewBusinessSetup({ businessBlueprint: value })}
                    placeholder="Offer, customer, problem, price, promise, constraints"
                  />
                </NewBusinessStage>
                <NewBusinessStage title="4. Operating setup" description="Define delivery, admin, finance, compliance, and tools before the hive treats work as launch-ready.">
                  <div className="grid gap-3 md:grid-cols-2">
                    <NewBusinessTextarea
                      id="new-business-delivery"
                      label="Delivery and operations"
                      value={state.newBusinessSetup.deliveryModel}
                      onChange={(value) => updateNewBusinessSetup({ deliveryModel: value })}
                      placeholder="Fulfilment, capacity, quality checks"
                    />
                    <NewBusinessTextarea
                      id="new-business-admin-finance"
                      label="Admin and finance baseline"
                      value={state.newBusinessSetup.adminFinanceModel}
                      onChange={(value) => updateNewBusinessSetup({ adminFinanceModel: value })}
                      placeholder="Bookkeeping, payments, admin setup"
                    />
                    <NewBusinessTextarea
                      id="new-business-legal"
                      label="Legal/admin/risk checklist"
                      value={state.newBusinessSetup.legalComplianceChecklist}
                      onChange={(value) => updateNewBusinessSetup({ legalComplianceChecklist: value })}
                      placeholder="Checklist prompts, not legal advice"
                    />
                    <NewBusinessTextarea
                      id="new-business-tools"
                      label="Tools/software stack"
                      value={state.newBusinessSetup.toolStack}
                      onChange={(value) => updateNewBusinessSetup({ toolStack: value })}
                      placeholder="Calendar, CRM, invoicing..."
                    />
                  </div>
                </NewBusinessStage>
                <NewBusinessStage title="5. Agent setup" description="Tell HiveWright the roles, SOPs, and safe loops agents should prepare first.">
                  <div className="grid gap-3 md:grid-cols-2">
                    <NewBusinessTextarea
                      id="new-business-sops"
                      label="Roles and SOP needs"
                      value={state.newBusinessSetup.rolesAndSops}
                      onChange={(value) => updateNewBusinessSetup({ rolesAndSops: value })}
                      placeholder="SOPs or roles needed before launch"
                    />
                    <NewBusinessTextarea
                      id="new-business-initial-loops"
                      label="Initial operating loops"
                      value={state.newBusinessSetup.initialLoops}
                      onChange={(value) => updateNewBusinessSetup({ initialLoops: value })}
                      placeholder="Weekly launch review, lead follow-up, fulfilment check"
                    />
                  </div>
                </NewBusinessStage>
                <NewBusinessStage title="6. Launch plan" description="Define readiness gates, roadmap milestones, draft marketing, and draft sales motion.">
                  <div className="grid gap-3 md:grid-cols-2">
                    <NewBusinessTextarea
                      id="new-business-launch-readiness"
                      label="Launch readiness criteria"
                      value={state.newBusinessSetup.launchReadiness}
                      onChange={(value) => updateNewBusinessSetup({ launchReadiness: value })}
                      placeholder="What must be true before public/customer-facing work?"
                    />
                    <NewBusinessTextarea
                      id="new-business-launch-roadmap"
                      label="Launch roadmap"
                      value={state.newBusinessSetup.launchRoadmap}
                      onChange={(value) => updateNewBusinessSetup({ launchRoadmap: value })}
                      placeholder="Validation, setup, assets, launch, review"
                    />
                    <NewBusinessTextarea
                      id="new-business-marketing"
                      label="Marketing channels to test"
                      value={state.newBusinessSetup.marketingModel}
                      onChange={(value) => updateNewBusinessSetup({ marketingModel: value })}
                      placeholder="Draft-only channels"
                    />
                    <NewBusinessTextarea
                      id="new-business-sales"
                      label="Sales motion"
                      value={state.newBusinessSetup.salesModel}
                      onChange={(value) => updateNewBusinessSetup({ salesModel: value })}
                      placeholder="How first buyers convert"
                    />
                  </div>
                </NewBusinessStage>
                <NewBusinessStage title="7. Approval-gated launch actions" description="List actions HiveWright may draft or queue, while public/spend/customer actions still wait for approval.">
                  <NewBusinessTextarea
                    id="new-business-launch-actions"
                    label="Approval-gated launch actions"
                    value={state.newBusinessSetup.launchActions}
                    onChange={(value) => updateNewBusinessSetup({ launchActions: value })}
                    placeholder="Publish, send, spend, customer-facing, financial, or system-change actions"
                  />
                </NewBusinessStage>
                <p className="text-xs leading-5 text-blue-900 dark:text-blue-200">
                  Public launch, ad spend, financial changes, and customer messages stay approval-gated. This intake only creates structured state and queued work.
                </p>
              </div>
            )}
            <div>
              <label htmlFor="hive-name" className="text-sm font-medium">Hive name *</label>
              <input
                id="hive-name"
                value={state.name}
                onChange={(e) => updateHiveName(e.target.value)}
                placeholder="My Hive"
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
              />
            </div>
            <details className="rounded-md border border-dashed p-3">
              <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
              <div className="mt-3">
                <label htmlFor="hive-address" className="text-sm font-medium">Custom hive address</label>
                <input
                  id="hive-address"
                  value={hiveAddress}
                  onChange={(e) => updateHiveAddress(e.target.value)}
                  placeholder="my-hive"
                  className="mt-1 w-full rounded-md border px-3 py-2 text-sm font-mono dark:bg-zinc-800"
                />
                <p className="mt-1 text-xs text-zinc-400">Used for this hive&apos;s local folders and links. Lowercase letters, numbers, and dashes work best.</p>
              </div>
            </details>
            <div>
              <label htmlFor="hive-type" className="text-sm font-medium">Type *</label>
              <select
                id="hive-type"
                value={state.type}
                onChange={(e) => update({ type: e.target.value })}
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
              >
                {HIVE_TYPES.map((type) => (
                  <option key={type} value={type}>{type.charAt(0).toUpperCase() + type.slice(1)}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="hive-description" className="text-sm font-medium">{kindDefaults.descriptionLabel}</label>
              <textarea
                id="hive-description"
                value={state.description}
                onChange={(e) => update({ description: e.target.value })}
                rows={3}
                placeholder={kindDefaults.descriptionPlaceholder}
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
              />
            </div>
            <div>
              <label htmlFor="hive-mission" className="text-sm font-medium">{kindDefaults.missionLabel}</label>
              <textarea
                id="hive-mission"
                value={state.mission}
                onChange={(e) => update({ mission: e.target.value })}
                rows={5}
                placeholder={kindDefaults.missionPlaceholder}
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
              />
              <p className="mt-1 text-xs text-zinc-400">Agents use this to decide what matters when work is ambiguous for this kind of hive.</p>
            </div>
            <div>
              <label htmlFor="hive-initial-goal" className="text-sm font-medium">{kindDefaults.initialGoalLabel}</label>
              <textarea
                id="hive-initial-goal"
                value={state.initialGoal}
                onChange={(e) => update({ initialGoal: e.target.value })}
                rows={2}
                placeholder={kindDefaults.initialGoalPlaceholder}
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
              />
              <p className="mt-1 text-xs text-zinc-400">HiveWright will turn this into a goal after the hive is created, or use a {kindDefaults.label.toLowerCase()} starter goal.</p>
            </div>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="space-y-4 rounded-lg border p-6" aria-labelledby="runtime-step-title">
          <div>
            <h2 id="runtime-step-title" className="text-lg font-medium">Choose agent runtimes</h2>
            <p className="text-sm text-zinc-500">Use Auto Routing unless you have a specific runtime preference. HiveWright will route each task to the best enabled, healthy model using its built-in model routing policy.</p>
          </div>

          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-100">
            <p className="font-medium">Runtime readiness check</p>
            <p className="mt-1">HiveWright checks this server now, not after you get stuck. CLI runtimes still need a signed-in session; setup health then runs the deeper worker probe after the hive exists.</p>
            <button
              type="button"
              onClick={loadSetupReadiness}
              disabled={setupReadinessLoading}
              className="mt-3 rounded-md border border-amber-300 px-3 py-1.5 text-xs hover:bg-amber-100 disabled:opacity-60 dark:border-amber-700 dark:hover:bg-amber-900/30"
            >
              {setupReadinessLoading ? "Checking..." : "Refresh runtime check"}
            </button>
            {setupReadinessError && <p role="alert" className="mt-2 text-xs">{setupReadinessError}</p>}
          </div>

          {setupReadiness && (
            <div className="grid gap-2 md:grid-cols-2">
              {selectedRuntimeAdapters.map((adapter) => {
                if (adapter === AUTO_MODEL_ROUTE) {
                  return (
                    <div key={adapter} className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
                      <p className="font-medium">Auto Routing: selected</p>
                      <p className="mt-1 text-xs">HiveWright will use the model routing system instead of pinning every role to one CLI.</p>
                      <p className="mt-1 text-xs font-medium">Next: make sure Model Setup has at least one enabled, healthy candidate.</p>
                    </div>
                  );
                }
                const runtime = setupReadiness.runtimes[adapter];
                return (
                  <div key={adapter} className={`rounded-md border p-3 text-sm ${runtime?.status === "ready" ? "border-green-200 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950/30 dark:text-green-100" : runtime?.status === "check_required" ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100" : "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-100"}`}>
                    <p className="font-medium">{runtime?.label ?? ADAPTER_LABELS[adapter] ?? adapter}: {runtimeStatusLabel(runtime?.status ?? "missing")}</p>
                    <p className="mt-1 text-xs">{runtime?.detail ?? "This runtime could not be checked."}</p>
                    <p className="mt-1 text-xs font-medium">Next: {runtime?.nextStep ?? "Choose another runtime or check setup health after launch."}</p>
                  </div>
                );
              })}
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            {RUNTIME_PRESETS.map((preset) => (
              <label key={preset.value} className="flex cursor-pointer gap-3 rounded-md border p-3 hover:bg-zinc-50 dark:hover:bg-zinc-900">
                <input
                  type="radio"
                  name="runtime-preset"
                  aria-label={`${preset.label} runtime preset`}
                  checked={preset.value === AUTO_MODEL_ROUTE ? runtimePresetIsAuto : !runtimePresetIsAuto && roles.every((role) => getSelectedAdapter(role) === preset.value)}
                  onChange={() => selectRuntimePreset(preset.value)}
                  className="mt-1"
                />
                <span>
                  <span className="block text-sm font-medium">{preset.label}</span>
                  <span className="block text-xs leading-5 text-zinc-500">{preset.description}</span>
                </span>
              </label>
            ))}
          </div>

          {rolesError && (
            <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
              {rolesError}
            </p>
          )}

          <div className="rounded-md border border-dashed p-3">
            <button
              type="button"
              onClick={() => setRuntimeAdvancedOpen((open) => !open)}
              className="text-sm font-medium"
              aria-expanded={runtimeAdvancedOpen}
            >
              Advanced runtime details
            </button>
            {runtimeAdvancedOpen && (
              <div className="mt-3 space-y-3">
                {roles.map((role, index) => {
                  const adapter = getSelectedAdapter(role);
                  const models = modelsForAdapter(adapter);
                  const currentModel = getSelectedModel(role);
                  return (
                    <div key={role.slug} className="rounded-md border p-3">
                      <div className="mb-3 flex items-start justify-between gap-3">
                        <div>
                          <div className="font-medium text-sm">{role.name}</div>
                          <div className="text-xs text-zinc-400">{role.department || "system"}</div>
                        </div>
                        {index === 0 && (
                          <button
                            type="button"
                            onClick={() => applyAdapterToAllRoles(adapter)}
                            className="rounded-md border px-2 py-1 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800"
                          >
                            Use this for all roles
                          </button>
                        )}
                      </div>
                      <div className="grid gap-2 md:grid-cols-2">
                        <div>
                          <label htmlFor={`adapter-${role.slug}`} className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Adapter</label>
                          <select
                            id={`adapter-${role.slug}`}
                            value={adapter}
                            onChange={(e) => setRoleOverride(role, "adapter", e.target.value)}
                            className="mt-1 w-full rounded border px-2 py-1.5 text-sm dark:bg-zinc-800"
                          >
                            {ADAPTER_GROUPS.map((group) => (
                              <optgroup key={group.label} label={group.label}>
                                {group.adapters.map((option) => (
                                  <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label htmlFor={`model-${role.slug}`} className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Model</label>
                          <select
                            id={`model-${role.slug}`}
                            value={models.includes(currentModel) ? currentModel : models[0]}
                            onChange={(e) => setRoleOverride(role, "model", e.target.value)}
                            className="mt-1 w-full rounded border px-2 py-1.5 text-sm dark:bg-zinc-800"
                          >
                            {models.map((model) => (
                              <option key={model} value={model}>{model}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {!rolesError && roles.length === 0 && (
                  <p className="text-sm text-zinc-400">Role defaults are loading.</p>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="space-y-4 rounded-lg border p-6" aria-labelledby="operating-step-title">
          <div>
            <h2 id="operating-step-title" className="text-lg font-medium">Set working preferences</h2>
            <p className="text-sm text-zinc-500">Choose how much initiative this hive should take when it starts operating.</p>
          </div>

          <div className="space-y-5">
            <div>
              <label htmlFor="max-concurrent-agents" className="text-sm font-medium">How many agents may work at once?</label>
              <input
                id="max-concurrent-agents"
                type="number"
                min={1}
                max={50}
                step={1}
                value={state.operatingPreferences.maxConcurrentAgents}
                onChange={(e) => updateOperatingPreferences({ maxConcurrentAgents: Number.parseInt(e.target.value, 10) || 1 })}
                className="mt-1 w-24 rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
              />
              <p className="mt-1 text-xs text-zinc-400">Three is a steady starting point: enough parallel work without making the hive noisy.</p>
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Should HiveWright look for useful work on its own?</legend>
              <RadioChoice
                name="proactive-work"
                checked={state.operatingPreferences.proactiveWork}
                onChange={() => updateOperatingPreferences({ proactiveWork: true })}
                title="Yes, keep an eye out"
                description="HiveWright will run its built-in recurring checks and bring important findings back to you."
              />
              <RadioChoice
                name="proactive-work"
                checked={!state.operatingPreferences.proactiveWork}
                onChange={() => updateOperatingPreferences({ proactiveWork: false })}
                title="No, wait for me"
                description="Recurring checks are created paused so you can turn them on later."
              />
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Should HiveWright prepare memory search for this hive?</legend>
              <RadioChoice
                name="memory-search"
                checked={state.operatingPreferences.memorySearch}
                onChange={() => updateOperatingPreferences({ memorySearch: true })}
                title="Yes, help future work remember context"
                description="HiveWright will use memory search only after the memory engine below is ready."
              />
              <RadioChoice
                name="memory-search"
                checked={!state.operatingPreferences.memorySearch}
                onChange={() => updateOperatingPreferences({ memorySearch: false })}
                title="Not yet"
                description="You can turn this on later after the hive is running."
              />
              {state.operatingPreferences.memorySearch && (
                <div className="rounded-md border bg-zinc-50 p-3 text-sm dark:bg-zinc-900">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="font-medium">Memory engine</p>
                      {embeddingSetupLoading && <p className="mt-1 text-xs text-zinc-500">Checking local memory setup...</p>}
                      {embeddingSetup && (
                        <>
                          <p className="mt-1 text-xs text-zinc-500">Default: {embeddingSetup.defaultConfig?.modelName ?? "nomic-embed-text-v2-moe:latest"} via local Ollama.</p>
                          <p className="mt-1 text-xs text-zinc-500">Status: {embeddingStatusLabel(embeddingSetup.status)}</p>
                        </>
                      )}
                      {embeddingSetupError && <p role="alert" className="mt-1 text-xs text-red-600">{embeddingSetupError}</p>}
                      {embeddingSetupAction && <p className="mt-1 text-xs text-green-700 dark:text-green-300">{embeddingSetupAction}</p>}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={loadEmbeddingSetup}
                        disabled={embeddingSetupLoading}
                        className="rounded-md border px-3 py-1.5 text-xs hover:bg-zinc-100 disabled:opacity-60 dark:hover:bg-zinc-800"
                      >
                        {embeddingSetupLoading ? "Checking..." : "Refresh"}
                      </button>
                      {embeddingSetup && !embeddingSetup.status?.ollamaReachable && (
                        <button
                          type="button"
                          onClick={() => runEmbeddingSetupAction("install")}
                          disabled={Boolean(embeddingSetupAction?.startsWith("Installing"))}
                          className="rounded-md border px-3 py-1.5 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
                        >
                          Install Ollama
                        </button>
                      )}
                      {embeddingSetup && embeddingSetup.status?.ollamaReachable && !embeddingSetup.status?.modelInstalled && (
                        <button
                          type="button"
                          onClick={() => runEmbeddingSetupAction("pull")}
                          disabled={Boolean(embeddingSetupAction?.startsWith("Pulling"))}
                          className="rounded-md border px-3 py-1.5 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
                        >
                          Pull memory model
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={useLocalEmbeddingSetup}
                        disabled={!embeddingSetup || embeddingSetup.status?.embeddingTest !== "passed" || Boolean(embeddingSetupAction?.startsWith("Saving"))}
                        className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                      >
                        Use local memory engine
                      </button>
                    </div>
                  </div>
                  {embeddingSetup && embeddingSetup.status?.embeddingTest !== "passed" && (
                    <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                      Memory search will stay off in practice until Ollama is reachable, {embeddingSetup.defaultConfig?.modelName ?? "nomic-embed-text-v2-moe:latest"} is installed, and the embedding test passes.
                    </p>
                  )}
                </div>
              )}
            </fieldset>


            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">How much freedom should this hive have on day one?</legend>
              <RadioChoice
                name="safety-preset"
                checked={state.safetyPreset === "open"}
                onChange={() => update({ safetyPreset: "open" })}
                title="Green — maximum autonomy"
                description="No approval gates for connected actions. HiveWright can read, send, change, spend, and delete using the connectors you add. Fastest, highest-trust mode."
              />
              <RadioChoice
                name="safety-preset"
                checked={state.safetyPreset === "owner_review_first"}
                onChange={() => update({ safetyPreset: "owner_review_first" })}
                title="Amber — supervised autonomy"
                description="Routine read and prep work can proceed. Sending, changing, spending, and system changes ask first. Destructive actions stay blocked."
              />
              <RadioChoice
                name="safety-preset"
                checked={state.safetyPreset === "locked_down"}
                onChange={() => update({ safetyPreset: "locked_down" })}
                title="Red — locked down"
                description="Inspect and draft only. External changes, spend, system changes, and destructive actions are blocked until you loosen the rules."
              />
            </fieldset>

            <div>
              <label htmlFor="request-sorting" className="text-sm font-medium">How should new requests be sorted?</label>
              <select
                id="request-sorting"
                value={state.operatingPreferences.requestSorting}
                onChange={(e) => updateOperatingPreferences({ requestSorting: e.target.value as RequestSortingPreset })}
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
              >
                <option value="balanced">Balanced: choose a task or goal based on the request</option>
                <option value="direct">Prefer direct tasks when the request is clear</option>
                <option value="goals">Prefer goals when the request may need planning</option>
              </select>
            </div>
          </div>
        </section>
      )}

      {step === 4 && (
        <section className="space-y-4 rounded-lg border p-6" aria-labelledby="ea-step-title">
          <div>
            <h2 id="ea-step-title" className="text-lg font-medium">Set up your Discord EA</h2>
            <p className="text-sm text-zinc-500">Your EA can answer you in Discord and help you start work without opening HiveWright.</p>
          </div>

          {connectorsLoading && <p className="text-sm text-zinc-400">Loading EA setup.</p>}
          {connectorsError && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
              <p>{connectorsError}</p>
              <button type="button" onClick={loadConnectors} className="mt-2 rounded-md border px-3 py-1 text-xs">Retry</button>
            </div>
          )}

          {!connectorsLoading && !connectorsError && !eaDiscordConnector && (
            <p className="rounded-md border border-dashed p-4 text-sm text-zinc-500">
              Discord EA setup is not available in this environment. You can create the hive now and add it later.
            </p>
          )}

          {eaDiscordConnector && (
            <EaDiscordSetup
              connector={eaDiscordConnector}
              fields={state.connectorFields[eaDiscordConnector.slug] ?? {}}
              displayName={state.connectorDisplayNames[eaDiscordConnector.slug] ?? ""}
              selection={state.connectorSelections[eaDiscordConnector.slug]}
              onSelect={selectConnector}
              onFieldChange={updateConnectorField}
              onDisplayNameChange={updateConnectorDisplayName}
            />
          )}
        </section>
      )}

      {step === 5 && (
        <section className="space-y-4 rounded-lg border p-6" aria-labelledby="connectors-step-title">
          <div>
            <h2 id="connectors-step-title" className="text-lg font-medium">Connect services</h2>
            <p className="text-sm text-zinc-500">Authorize the services this hive can use. You can skip any connector and add it later.</p>
          </div>

          {connectorsLoading && <p className="text-sm text-zinc-400">Loading connector catalog.</p>}
          {connectorsError && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
              <p>{connectorsError}</p>
              <button type="button" onClick={loadConnectors} className="mt-2 rounded-md border px-3 py-1 text-xs">Retry</button>
            </div>
          )}
          {!connectorsLoading && !connectorsError && serviceConnectors.length === 0 && (
            <p className="rounded-md border border-dashed p-4 text-sm text-zinc-500">No connectors are available in this environment. You can create the hive now and add services later.</p>
          )}

          {recommendedConnectors.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium">Recommended</h3>
              <div className="grid gap-3 md:grid-cols-2">
                {recommendedConnectors.map((connector) => (
                  <ConnectorCard
                    key={connector.slug}
                    connector={connector}
                    expanded={expandedConnector === connector.slug}
                    fields={state.connectorFields[connector.slug] ?? {}}
                    displayName={state.connectorDisplayNames[connector.slug] ?? ""}
                    selection={state.connectorSelections[connector.slug]}
                    onToggle={() => setExpandedConnector(expandedConnector === connector.slug ? null : connector.slug)}
                    onSelect={selectConnector}
                    onFieldChange={updateConnectorField}
                    onDisplayNameChange={updateConnectorDisplayName}
                  />
                ))}
              </div>
            </div>
          )}

          {Object.keys(connectorsByCategory).length > 0 && (
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer text-sm font-medium">Browse all connectors</summary>
              <div className="mt-3 space-y-4">
                {Object.entries(connectorsByCategory).map(([category, list]) => (
                  <div key={category}>
                    <p className="mb-2 text-xs font-medium uppercase text-zinc-500">{category}</p>
                    <div className="grid gap-3 md:grid-cols-2">
                      {list.map((connector) => (
                        <ConnectorCard
                          key={connector.slug}
                          connector={connector}
                          expanded={expandedConnector === connector.slug}
                          fields={state.connectorFields[connector.slug] ?? {}}
                          displayName={state.connectorDisplayNames[connector.slug] ?? ""}
                          selection={state.connectorSelections[connector.slug]}
                          onToggle={() => setExpandedConnector(expandedConnector === connector.slug ? null : connector.slug)}
                          onSelect={selectConnector}
                          onFieldChange={updateConnectorField}
                          onDisplayNameChange={updateConnectorDisplayName}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}

          <details className="rounded-md border border-dashed p-3">
            <summary className="cursor-pointer text-sm font-medium">Advanced manual setup</summary>
            <p className="mt-2 text-sm text-zinc-500">
              Use this only when there is no connector or authorization flow for the service yet. Manual values stay scoped to the connector you configure here.
            </p>
          </details>
        </section>
      )}

      {step === PROJECTS_STEP && (
        <section className="space-y-4 rounded-lg border p-6" aria-labelledby="projects-step-title">
          <div>
            <h2 id="projects-step-title" className="text-lg font-medium">Projects</h2>
            <p className="text-sm text-zinc-500">Add projects this hive should operate on. You can add more later.</p>
          </div>

          {state.projects.map((project, index) => (
            <div key={index} className="space-y-2 rounded-md border p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Project {index + 1}</span>
                <button onClick={() => removeProject(index)} className="text-xs text-red-500 hover:underline">Remove</button>
              </div>
              <div>
                <label htmlFor={`project-name-${index}`} className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Name *</label>
                <input
                  id={`project-name-${index}`}
                  placeholder="HiveWright v2"
                  value={project.name}
                  onChange={(e) => updateProject(index, "name", e.target.value)}
                  className="mt-1 w-full rounded-md border px-3 py-1.5 text-sm dark:bg-zinc-800"
                />
              </div>
              <div>
                <label htmlFor={`project-slug-${index}`} className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Project address *</label>
                <input
                  id={`project-slug-${index}`}
                  placeholder="hivewrightv2"
                  value={project.slug}
                  onChange={(e) => updateProject(index, "slug", e.target.value)}
                  className="mt-1 w-full rounded-md border px-3 py-1.5 text-sm font-mono dark:bg-zinc-800"
                />
              </div>
              <div className="rounded-md border border-dashed p-3">
                <button
                  type="button"
                  onClick={() => setProjectAdvancedOpen((prev) => ({ ...prev, [index]: !prev[index] }))}
                  className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
                  aria-expanded={Boolean(projectAdvancedOpen[index])}
                >
                  Advanced project details
                </button>
                {projectAdvancedOpen[index] && (
                  <div className="mt-3">
                    <label htmlFor={`project-workspace-${index}`} className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Local folder override</label>
                    <input
                      id={`project-workspace-${index}`}
                      placeholder="Optional folder for agent work"
                      value={project.workspacePath}
                      onChange={(e) => updateProject(index, "workspacePath", e.target.value)}
                      className="mt-1 w-full rounded-md border px-3 py-1.5 text-sm dark:bg-zinc-800"
                    />
                    <p className="mt-1 text-xs text-zinc-400">Optional. Leave this blank unless an operator gave you a specific folder to use.</p>
                    <label className="mt-3 flex items-start gap-2 text-xs text-zinc-500">
                      <input
                        type="checkbox"
                        checked={project.gitRepo}
                        onChange={(e) => updateProject(index, "gitRepo", e.target.checked)}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="font-medium text-zinc-700 dark:text-zinc-200">Git-backed code project</span>
                        <span className="block">Use only when the folder is already a Git repository. These projects get isolated worktrees and commit/SHA requirements.</span>
                      </span>
                    </label>
                  </div>
                )}
              </div>
            </div>
          ))}

          <button onClick={addProject} className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800">
            + Add Project
          </button>

          {state.projects.length === 0 && (
            <p className="text-xs text-zinc-400">No projects added yet.</p>
          )}
        </section>
      )}

      {step === REVIEW_STEP && (
        <section className="space-y-4 rounded-lg border p-6" aria-labelledby="review-step-title">
          <div>
            <h2 id="review-step-title" className="text-lg font-medium">Dashboard handoff</h2>
            <p className="text-sm text-zinc-500">Review the hive, runtime choices, connectors, projects, first goal, and starting review cadence before opening the hive dashboard.</p>
          </div>
          <div className="space-y-3 text-sm">
            <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
              <p className="font-medium">{state.name}</p>
              <p className="text-zinc-500">{kindDefaults.label} · {state.type} · Hive address: {hiveAddress}</p>
              <p className="mt-1 text-zinc-500">Mission: {state.mission ? "provided" : "not provided"}</p>
              <p className="text-zinc-500">First goal: {state.initialGoal ? "provided" : "not provided"}</p>
            </div>
            {state.kind === "business" && (
              <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
                <p className="font-medium mb-1">Business OS</p>
                <p className="text-zinc-500">Mode: {state.businessMode === "new_business" ? "new business setup" : "existing business audit"}</p>
                {state.businessMode === "new_business" && (
                  <>
                    <p className="text-zinc-500">Setup profile: {state.newBusinessSetup.idea || state.description || state.mission ? "will be created" : "starter profile will be created"}</p>
                    <p className="text-zinc-500">Output: structured setup profile, readiness rows, setup gaps, and approval-gated actions.</p>
                  </>
                )}
              </div>
            )}
            <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
              <p className="font-medium mb-1">Runtime selection</p>
              {runtimePresetIsAuto ? (
                <p className="text-zinc-400">Auto Routing: HiveWright will set roles to `auto` and choose the best enabled, healthy model per task through the model routing system.</p>
              ) : (
                Object.entries(state.roleOverrides).map(([slug, override]) => (
                  <p key={slug} className="text-zinc-500">
                    {slug}: {override.adapter ? ADAPTER_LABELS[override.adapter] ?? override.adapter : "default"} / {override.model ?? "default"}
                  </p>
                ))
              )}
            </div>
            <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
              <p className="font-medium mb-1">Working preferences</p>
              <p className="text-zinc-500">Agents at once: {state.operatingPreferences.maxConcurrentAgents}</p>
              <p className="text-zinc-500">Looks for useful work: {state.operatingPreferences.proactiveWork ? "yes" : "paused"}</p>
              <p className="text-zinc-500">Memory search: {state.operatingPreferences.memorySearch ? "will be checked before use" : "off until you enable it"}</p>
              <p className="text-zinc-500">Request sorting: {requestSortingLabel(state.operatingPreferences.requestSorting)}</p>
            </div>
            <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
              <p className="font-medium mb-1">Safety</p>
              <p className="text-zinc-500">{safetyPresetLabel(state.safetyPreset)}</p>
              <p className="text-zinc-500">Setup health will confirm these rules are active before the hive does real external work.</p>
            </div>
            <div className={`rounded-md p-3 ${launchBlockingIssues.length > 0 ? "border border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-100" : "bg-green-50 text-green-900 dark:bg-green-950/30 dark:text-green-100"}`}>
              <p className="font-medium mb-1">Launch readiness</p>
              {launchBlockingIssues.length > 0 ? (
                <>
                  <p className="text-sm">HiveWright will not launch this hive as ready until these are fixed:</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                    {launchBlockingIssues.map((issue) => <li key={issue}>{issue}</li>)}
                  </ul>
                </>
              ) : (
                <ul className="space-y-1 text-sm">
                  <li>Runtime: selected worker route passed the available readiness check.</li>
                  <li>Memory: configured state matches your memory choice.</li>
                  <li>Services: configured services will be installed, tested, and activated during launch.</li>
                  <li>Safety: conservative approval policies will be seeded before work starts.</li>
                </ul>
              )}
            </div>
            <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
              <p className="font-medium mb-1">Connected services</p>
              {connectors.length === 0 ? (
                <p className="text-zinc-400">No services selected. Add connectors later in Settings.</p>
              ) : (
                connectors
                  .filter((connector) => state.connectorSelections[connector.slug])
                  .map((connector) => (
                    <p key={connector.slug} className="text-zinc-500">
                      {connector.name}: {connectorStatusLabel(state.connectorSelections[connector.slug])}
                      {connector.requiresDispatcherRestart && state.connectorSelections[connector.slug] === "configured" ? " · activation requires dispatcher restart" : ""}
                    </p>
                  ))
              )}
              {connectors.some((connector) => state.connectorSelections[connector.slug]) ? null : (
                <p className="text-zinc-400">All connectors skipped for now.</p>
              )}
            </div>
            {hasProjectsStep && (
              <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
                <p className="font-medium mb-1">Projects ({state.projects.filter((project) => project.name && project.slug).length})</p>
                {state.projects.filter((project) => project.name && project.slug).map((project, index) => (
                  <p key={index} className="text-zinc-500">
                    {project.name} ({project.slug}){project.workspacePath ? " · advanced folder saved" : ""}{project.gitRepo ? " · git-backed" : ""}
                  </p>
                ))}
                {state.projects.filter((project) => project.name && project.slug).length === 0 && (
                  <p className="text-zinc-400">No projects configured.</p>
                )}
              </div>
            )}
          </div>
          {setupStatus && <p className="text-sm text-zinc-500">{setupStatus}</p>}
          {error && (
            <p role="alert" className="text-sm text-red-500">
              {error} Nothing has been marked complete. You can fix the issue and try again.
            </p>
          )}
        </section>
      )}

      <div className="flex justify-between">
        <button
          onClick={goBack}
          disabled={isFirstStep}
          className="rounded-md border px-4 py-2 text-sm disabled:opacity-30 hover:bg-zinc-50 dark:hover:bg-zinc-800"
        >
          Back
        </button>
        {!isLastStep ? (
          <button
            onClick={goNext}
            disabled={step === 1 && !state.name}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Next
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={submitting || launchBlockingIssues.length > 0}
            className="rounded-md bg-green-600 px-6 py-2 text-sm text-white hover:bg-green-700 disabled:opacity-50"
          >
            {submitting ? "Setting up..." : error ? "Retry setup" : "Create Hive"}
          </button>
        )}
      </div>
    </div>
  );
}

function RadioChoice({
  name,
  checked,
  onChange,
  title,
  description,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  title: string;
  description: string;
}) {
  return (
    <label className="flex cursor-pointer gap-3 rounded-md border p-3 hover:bg-zinc-50 dark:hover:bg-zinc-900">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        aria-label={title}
        className="mt-1"
      />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs leading-5 text-zinc-500">{description}</span>
      </span>
    </label>
  );
}

function NewBusinessStage({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-md border border-blue-200 bg-white/70 p-3 dark:border-blue-900 dark:bg-zinc-950/50">
      <div>
        <h3 className="text-sm font-semibold text-blue-950 dark:text-blue-100">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-blue-900 dark:text-blue-200">{description}</p>
      </div>
      {children}
    </section>
  );
}

function NewBusinessTextarea({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-xs font-medium text-zinc-700 dark:text-zinc-200">{label}</label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        placeholder={placeholder}
        className="mt-1 w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
      />
    </div>
  );
}

function textAreaList(value: string): string[] {
  return value
    .split(/\n|,/)
    .map((item) => item.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

function textAreaNotes(key: string, value: string): Record<string, unknown> {
  const notes = textAreaList(value);
  return notes.length > 0 ? { [key]: notes } : {};
}

function requestSortingLabel(preset: RequestSortingPreset): string {
  if (preset === "direct") return "prefer direct tasks";
  if (preset === "goals") return "prefer goals";
  return "balanced";
}

function runtimeStatusLabel(status: RuntimeStatus): string {
  if (status === "ready") return "ready";
  if (status === "check_required") return "installed, login/probe still required";
  return "not ready";
}

function embeddingStatusLabel(status?: LocalEmbeddingSetupStatus): string {
  if (!status) return "not ready — local memory setup has not been checked";
  if (status.embeddingTest === "passed") return "ready — local embedding test passed";
  if (!status.ollamaReachable) return "not ready — Ollama is not reachable";
  if (!status.modelInstalled) return `not ready — ${status.modelName} is not installed`;
  return status.error ? `not ready — ${status.error}` : "not ready — embedding test has not passed";
}

function safetyPresetLabel(preset: SafetyPreset): string {
  if (preset === "open") return "Green — maximum autonomy: no approval gates for connected actions.";
  if (preset === "locked_down") return "Red — locked down: inspect and draft only; external actions are blocked.";
  return "Amber — supervised autonomy: routine prep can proceed; external changes ask first.";
}

function EaDiscordSetup({
  connector,
  fields,
  displayName,
  selection,
  onSelect,
  onFieldChange,
  onDisplayNameChange,
}: {
  connector: Connector;
  fields: Record<string, string>;
  displayName: string;
  selection?: "skipped" | "configure-later" | "configured";
  onSelect: (slug: string, selection: "skipped" | "configure-later" | "configured") => void;
  onFieldChange: (slug: string, key: string, value: string) => void;
  onDisplayNameChange: (slug: string, value: string) => void;
}) {
  const configured = connector.setupFields.every((field) => !field.required || fields[field.key]);
  const applicationField = connector.setupFields.find((field) => field.key === "applicationId");
  const channelField = connector.setupFields.find((field) => field.key === "channelId");
  const tokenField = connector.setupFields.find((field) => field.key === "botToken");
  const optionalFields = connector.setupFields.filter((field) => !["applicationId", "channelId", "botToken"].includes(field.key));
  const inviteUrl = discordBotInviteUrl(fields.applicationId ?? "");

  return (
    <div className="space-y-4">
      <div className="rounded-md border bg-zinc-50 p-4 dark:bg-zinc-900">
        <div className="flex items-start gap-3">
          <span className="text-2xl" aria-hidden="true">{connector.icon ?? "*"}</span>
          <div className="min-w-0 flex-1">
            <p className="font-medium">{connector.name}</p>
            <p className="text-sm text-zinc-500">Add the Discord app details now, or do it later from Settings.</p>
            {selection && <p className="mt-1 text-xs text-zinc-500">Status: {connectorStatusLabel(selection)}</p>}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="rounded-md border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-950 dark:border-indigo-800 dark:bg-indigo-950/30 dark:text-indigo-100">
          <p className="font-medium">Add the bot to your Discord server</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>Paste the Discord Application ID below.</li>
            <li>Use the invite button to add the bot to your server.</li>
            <li>In Discord, give the bot role access to the channel: View Channel, Send Messages, and Use Slash Commands.</li>
            <li>Paste the allowed channel ID and bot token, then save this EA setup.</li>
          </ol>
          {inviteUrl ? (
            <a
              href={inviteUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex rounded-md bg-indigo-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600"
            >
              Add bot to Discord server
            </a>
          ) : (
            <p className="mt-3 text-xs text-indigo-800 dark:text-indigo-200">The invite button appears after you enter the Discord Application ID.</p>
          )}
        </div>

        <div>
          <label htmlFor="ea-display-name" className="text-sm font-medium">Name shown in HiveWright</label>
          <input
            id="ea-display-name"
            value={displayName}
            onChange={(e) => onDisplayNameChange(connector.slug, e.target.value)}
            placeholder={connector.name}
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
          />
        </div>

        {applicationField && (
          <ConnectorFieldInput
            connector={connector}
            field={applicationField}
            fields={fields}
            onFieldChange={onFieldChange}
          />
        )}

        {channelField && (
          <ConnectorFieldInput
            connector={connector}
            field={{
              ...channelField,
              label: "Allowed Discord channel ID",
              helpText: "The EA will listen in this channel, plus direct messages. You can change it later.",
            }}
            fields={fields}
            onFieldChange={onFieldChange}
          />
        )}

        {tokenField && (
          <ConnectorFieldInput
            connector={connector}
            field={tokenField}
            fields={fields}
            onFieldChange={onFieldChange}
          />
        )}

        {optionalFields.length > 0 && (
          <details className="rounded-md border border-dashed p-3">
            <summary className="cursor-pointer text-sm font-medium">Optional Discord settings</summary>
            <div className="mt-3 space-y-3">
              {optionalFields.map((field) => (
                <ConnectorFieldInput
                  key={field.key}
                  connector={connector}
                  field={field}
                  fields={fields}
                  onFieldChange={onFieldChange}
                />
              ))}
            </div>
          </details>
        )}
      </div>

      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-100">
        <p className="font-medium">Test message</p>
        <p className="mt-1">Testing is available after this setup is saved, because HiveWright needs to install the EA before it can send the Discord check.</p>
        <button
          type="button"
          disabled
          className="mt-3 rounded-md border border-amber-300 px-3 py-1.5 text-xs opacity-60 dark:border-amber-700"
        >
          Test after setup
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onSelect(connector.slug, configured ? "configured" : "configure-later")}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {configured ? "Use this EA setup" : "Save for later"}
        </button>
        <button
          type="button"
          onClick={() => onSelect(connector.slug, "configure-later")}
          className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800"
        >
          I&apos;ll do this later
        </button>
      </div>
    </div>
  );
}

function ConnectorCard({
  connector,
  expanded,
  fields,
  displayName,
  selection,
  onToggle,
  onSelect,
  onFieldChange,
  onDisplayNameChange,
}: {
  connector: Connector;
  expanded: boolean;
  fields: Record<string, string>;
  displayName: string;
  selection?: "skipped" | "configure-later" | "configured";
  onToggle: () => void;
  onSelect: (slug: string, selection: "skipped" | "configure-later" | "configured") => void;
  onFieldChange: (slug: string, key: string, value: string) => void;
  onDisplayNameChange: (slug: string, value: string) => void;
}) {
  const configured = connector.setupFields.length > 0
    ? connector.setupFields.every((field) => !field.required || fields[field.key])
    : true;
  const isOAuth = connector.authType === "oauth2";

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start gap-3">
        <span className="text-2xl" aria-hidden="true">{connector.icon ?? "*"}</span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{connector.name}</p>
          <p className="text-xs text-zinc-500">{connectorDescription(connector)}</p>
          {connector.requiresDispatcherRestart && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-300">Activation requires a dispatcher restart after install.</p>
          )}
          {selection && (
            <p className="mt-1 text-xs text-zinc-500">Status: {connectorStatusLabel(selection)}</p>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {isOAuth ? (
          <button
            type="button"
            onClick={() => onSelect(connector.slug, "configure-later")}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Connect after launch
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              onToggle();
              onSelect(connector.slug, configured ? "configured" : "configure-later");
            }}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {connector.authType === "none" ? "Add connector" : `Configure ${connector.name}`}
          </button>
        )}
        <button
          type="button"
          onClick={() => onSelect(connector.slug, "skipped")}
          className="rounded-md border px-3 py-1.5 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800"
        >
          Skip
        </button>
      </div>

      {isOAuth && (
        <p className="mt-2 text-xs text-zinc-500">
          You can finish this connection from Settings after the hive is created.
        </p>
      )}

      {expanded && !isOAuth && (
        <div className="mt-3 space-y-2 border-t pt-3">
          <div>
            <label htmlFor={`connector-display-${connector.slug}`} className="text-xs text-zinc-600 dark:text-zinc-400">Display name</label>
            <input
              id={`connector-display-${connector.slug}`}
              value={displayName}
              onChange={(e) => onDisplayNameChange(connector.slug, e.target.value)}
              placeholder={connector.name}
              className="mt-1 w-full rounded border px-2 py-1 text-sm dark:bg-zinc-800"
            />
          </div>
          {connector.setupFields.map((field) => (
            <ConnectorFieldInput
              key={field.key}
              connector={connector}
              field={field}
              fields={fields}
              onFieldChange={onFieldChange}
              compact
            />
          ))}
          <button
            type="button"
            onClick={() => onSelect(connector.slug, configured ? "configured" : "configure-later")}
            className="rounded-md border px-3 py-1.5 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800"
          >
            {configured ? "Use this setup" : "Save for later"}
          </button>
        </div>
      )}
    </div>
  );
}

function ConnectorFieldInput({
  connector,
  field,
  fields,
  onFieldChange,
  compact = false,
}: {
  connector: Connector;
  field: SetupField;
  fields: Record<string, string>;
  onFieldChange: (slug: string, key: string, value: string) => void;
  compact?: boolean;
}) {
  const inputId = `connector-${connector.slug}-${field.key}`;
  const labelClassName = compact
    ? "text-xs text-zinc-600 dark:text-zinc-400"
    : "text-sm font-medium";
  const controlClassName = compact
    ? "mt-1 w-full rounded border px-2 py-1 text-sm dark:bg-zinc-800"
    : "mt-1 w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800";

  return (
    <div>
      <label htmlFor={inputId} className={labelClassName}>
        {field.label}
        {field.required && <span className="text-red-500"> *</span>}
      </label>
      {field.type === "textarea" ? (
        <textarea
          id={inputId}
          value={fields[field.key] ?? ""}
          onChange={(e) => onFieldChange(connector.slug, field.key, e.target.value)}
          placeholder={field.placeholder}
          rows={compact ? 2 : 3}
          className={controlClassName}
        />
      ) : (
        <input
          id={inputId}
          type={field.type === "password" ? "password" : "text"}
          value={fields[field.key] ?? ""}
          onChange={(e) => onFieldChange(connector.slug, field.key, e.target.value)}
          placeholder={field.placeholder}
          className={controlClassName}
        />
      )}
      {field.helpText && <p className="mt-1 text-xs text-zinc-400">{field.helpText}</p>}
    </div>
  );
}

function normalizeAdapter(adapter: string) {
  if (adapter === "mistral") return adapter;
  return ADAPTER_LABELS[adapter] ? adapter : "codex";
}

function connectorStatusLabel(selection?: "skipped" | "configure-later" | "configured") {
  switch (selection) {
    case "configured":
      return "configured for install during launch";
    case "configure-later":
      return "set aside for Settings after launch";
    case "skipped":
      return "skipped";
    default:
      return "not selected";
  }
}

function connectorDescription(connector: Connector) {
  if (connector.slug === "ea-discord") {
    return "Hosts this hive's Executive Assistant on Discord through the connector system.";
  }
  return connector.description.replace(/\s*Replaces the legacy gateway EA\./g, "");
}
