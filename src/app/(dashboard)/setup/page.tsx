import Link from "next/link";

const recommendedSetupSteps = [
  { href: "/hives/new", title: "1. Create a hive", description: "Name the hive, set the mission, choose safe defaults, and launch in an honest readiness state." },
  { href: "/setup/health", title: "2. Check readiness", description: "See exactly what is ready, skipped, or still needs attention before agents operate." },
  { href: "/setup/action-policies", title: "3. Confirm safety", description: "Pick owner-review rules so agents know what they may do without asking." },
  { href: "/setup/connectors", title: "4. Test front doors", description: "Connect and test chat, service connectors, and other ways the hive receives work." },
];

const hiveSetupLinks = [
  {
    href: "/setup/models",
    title: "Models",
    description: "Hive model credentials, health, quality, cost, and routing controls.",
  },
  {
    href: "/setup/connectors",
    title: "Connectors",
    description: "Hive-scoped integrations, connector credentials, grants, and action history.",
  },
  {
    href: "/setup/action-policies",
    title: "Action Policies",
    description: "Hive-scoped allow, approval, and block policies for connector actions.",
  },
  {
    href: "/setup/health",
    title: "Setup Health",
    description: "Readiness checks for the selected hive across runtime, models, memory, safety, and connectors.",
  },
  {
    href: "/setup/workflow-capture",
    title: "Capture a Workflow",
    description: "Record how your business already does a task so HiveWright can turn it into repeatable work.",
  },
  {
    href: "/setup/sop-importer",
    title: "Import Existing Workflows",
    description: "Bring in SOPs and process documents instead of starting from a blank page.",
  },
];

const globalSetupLinks = [
  {
    href: "/settings",
    title: "Global Settings",
    description: "Shared credentials, notifications, quality controls, workspace roots, and owner-wide runtime settings.",
  },
  {
    href: "/setup/health",
    title: "Storage & workspace root",
    description: "Where HiveWright creates hive folders and project workspaces. Setup health shows the active location and restart note.",
  },
  {
    href: "/settings/adapters",
    title: "Adapters",
    description: "HiveWright runtime adapter defaults for Codex, Claude Code, Gemini, OpenClaw, and Ollama.",
  },
  {
    href: "/settings/embeddings",
    title: "Embeddings",
    description: "System-wide memory embedding provider, model, credential, and endpoint setup.",
  },
  {
    href: "/settings/work-intake",
    title: "Work Intake Classifier",
    description: "Global classifier provider, model, fallback, and tuning for incoming work.",
  },
  {
    href: "/setup/updates",
    title: "HiveWright Updates",
    description: "Version, Git remote status, terminal update command, and owner-triggered HiveWright updates.",
  },
];

function withTargetHiveId(href: string, targetHiveId: string | null) {
  if (!targetHiveId || href === "/hives/new") return href;
  const [base, query = ""] = href.split("?");
  const params = new URLSearchParams(query);
  params.set("targetHiveId", targetHiveId);
  return `${base}?${params.toString()}`;
}

function SetupLinkCard({ href, title, description }: { href: string; title: string; description: string }) {
  return (
    <Link
      href={href}
      className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm transition hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-700"
    >
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-2 text-xs leading-5 text-zinc-500">{description}</p>
    </Link>
  );
}

export default async function SetupPage({
  searchParams,
}: {
  searchParams?: Promise<{ targetHiveId?: string | string[] }>;
}) {
  const resolvedSearchParams = await searchParams;
  const rawTargetHiveId = Array.isArray(resolvedSearchParams?.targetHiveId)
    ? resolvedSearchParams?.targetHiveId[0]
    : resolvedSearchParams?.targetHiveId;
  const targetHiveId = rawTargetHiveId?.trim() || null;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Setup</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          Hive setup is isolated to the selected hive. Global HiveWright settings apply across the whole installation.
        </p>
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Recommended first-run path</h2>
          <p className="mt-1 text-sm text-zinc-500">Start here if you are setting up HiveWright for the first time.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {recommendedSetupSteps.map((link) => (
            <SetupLinkCard key={link.href} {...link} href={withTargetHiveId(link.href, targetHiveId)} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Selected hive setup</h2>
          <p className="mt-1 text-sm text-zinc-500">These settings follow the active hive in the dashboard switcher.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {hiveSetupLinks.map((link) => (
            <SetupLinkCard key={link.href} {...link} href={withTargetHiveId(link.href, targetHiveId)} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Global HiveWright setup</h2>
          <p className="mt-1 text-sm text-zinc-500">These settings affect the whole HiveWright runtime, not one isolated hive.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {globalSetupLinks.map((link) => (
            <SetupLinkCard key={link.href} {...link} href={withTargetHiveId(link.href, targetHiveId)} />
          ))}
        </div>
      </section>
    </div>
  );
}
