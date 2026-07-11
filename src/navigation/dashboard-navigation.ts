export type DashboardNavigationContext = {
  activeHiveId?: string;
  qualityFeedbackCount?: number;
  unreadOutcomesCount?: number;
};

export type DashboardNavigationLink = {
  id: string;
  href: string;
  label: string;
  badgeCount?: number;
  isActive?: (pathname: string) => boolean;
};

export type DashboardNavigationGroup = {
  id: string;
  label: string;
  href?: string;
  isActive?: (pathname: string) => boolean;
  links: DashboardNavigationLink[];
  global?: boolean;
};

function hiveHref(activeHiveId: string | undefined, section: "ideas" | "initiatives" | "files") {
  return activeHiveId ? `/hives/${activeHiveId}/${section}` : "/hives";
}

function hiveSectionIsActive(section: "ideas" | "initiatives" | "files", href: string) {
  return (pathname: string) =>
    pathname === href || (pathname.startsWith("/hives/") && pathname.endsWith(`/${section}`));
}

function proceduresIsActive(pathname: string) {
  return (
    pathname === "/pipelines" ||
    pathname.startsWith("/pipelines/") ||
    pathname === "/setup/workflow-capture" ||
    pathname.startsWith("/setup/workflow-capture/") ||
    pathname === "/setup/sop-importer" ||
    pathname.startsWith("/setup/sop-importer/")
  );
}

function globalSettingsIsActive(...paths: string[]) {
  return (pathname: string) => paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export function dashboardNavigationLinkIsActive(link: DashboardNavigationLink, pathname: string) {
  return link.isActive
    ? link.isActive(pathname)
    : pathname === link.href || (link.href !== "/" && pathname.startsWith(link.href));
}

export function dashboardNavigationGroupIsActive(group: DashboardNavigationGroup, pathname: string) {
  if (group.isActive?.(pathname)) return true;
  if (
    group.href &&
    (pathname === group.href || (group.href !== "/" && pathname.startsWith(group.href)))
  ) {
    return true;
  }
  return group.links.some((link) => dashboardNavigationLinkIsActive(link, pathname));
}

export function buildDashboardNavigation({
  activeHiveId,
  qualityFeedbackCount = 0,
  unreadOutcomesCount = 0,
}: DashboardNavigationContext): DashboardNavigationGroup[] {
  const ideasHref = hiveHref(activeHiveId, "ideas");
  const initiativesHref = hiveHref(activeHiveId, "initiatives");
  const filesHref = hiveHref(activeHiveId, "files");

  return [
    {
      id: "dashboard",
      label: "Dashboard",
      href: "/",
      isActive: (pathname) => pathname === "/",
      links: [],
    },
    {
      id: "business-os",
      label: "Business OS",
      href: "/business-os",
      isActive: (pathname) => pathname === "/business-os" || pathname.startsWith("/business-os/"),
      links: [],
    },
    {
      id: "supervision",
      label: "Supervision",
      href: "/supervision",
      isActive: (pathname) => pathname === "/supervision",
      links: [],
    },
    {
      id: "marketing",
      label: "Marketing",
      href: "/marketing",
      isActive: (pathname) => pathname === "/marketing" || pathname.startsWith("/marketing/"),
      links: [],
    },
    {
      id: "sales",
      label: "Sales",
      href: "/sales",
      isActive: (pathname) => pathname === "/sales" || pathname.startsWith("/sales/"),
      links: [],
    },
    {
      id: "work",
      label: "Work",
      links: [
        { id: "tasks", href: "/tasks", label: "Tasks" },
        {
          id: "deliverables",
          href: "/deliverables",
          label: "Final outputs",
          badgeCount: unreadOutcomesCount > 0 ? unreadOutcomesCount : undefined,
        },
        { id: "procedures", href: "/pipelines", label: "Procedures", isActive: proceduresIsActive },
        { id: "goals", href: "/goals", label: "Goals" },
        {
          id: "initiatives",
          href: initiativesHref,
          label: "Initiatives",
          isActive: hiveSectionIsActive("initiatives", initiativesHref),
        },
        { id: "work-intake", href: "/intake", label: "Work Intake" },
        { id: "projects", href: "/projects", label: "Projects" },
        {
          id: "ideas",
          href: ideasHref,
          label: "Ideas",
          isActive: hiveSectionIsActive("ideas", ideasHref),
        },
      ],
    },
    {
      id: "inbox",
      label: "Inbox",
      links: [
        { id: "decisions", href: "/decisions", label: "Decisions" },
        {
          id: "quality-feedback",
          href: "/quality-feedback",
          label: "Quality feedback",
          badgeCount: qualityFeedbackCount > 0 ? qualityFeedbackCount : undefined,
        },
      ],
    },
    {
      id: "schedules",
      label: "Schedules",
      href: "/schedules",
      links: [],
    },
    {
      id: "memory",
      label: "Memory",
      links: [
        { id: "memory", href: "/memory", label: "Overview" },
        { id: "memory-health", href: "/memory/health", label: "Memory Health" },
        { id: "memory-timeline", href: "/memory/timeline", label: "Memory Timeline" },
        { id: "insights", href: "/memory/insights", label: "Insights" },
      ],
    },
    {
      id: "analytics",
      label: "Analytics",
      href: "/analytics",
      links: [],
    },
    {
      id: "operations",
      label: "Operations",
      links: [
        { id: "roles", href: "/roles", label: "Roles" },
        { id: "health", href: "/health", label: "Health" },
        { id: "board", href: "/board", label: "Board" },
        { id: "voice", href: "/voice", label: "Voice" },
        {
          id: "files",
          href: filesHref,
          label: "Files",
          isActive: hiveSectionIsActive("files", filesHref),
        },
        { id: "docs", href: "/docs", label: "Docs" },
      ],
    },
    {
      id: "setup",
      label: "Hive Setup",
      links: [
        { id: "setup", href: "/setup", label: "Overview", isActive: (pathname) => pathname === "/setup" },
        { id: "models", href: "/setup/models", label: "Models" },
        { id: "connectors", href: "/setup/connectors", label: "Connectors" },
        { id: "action-policies", href: "/setup/action-policies", label: "Action Policies" },
        { id: "setup-health", href: "/setup/health", label: "Setup Health" },
      ],
    },
    {
      id: "global",
      label: "Global",
      global: true,
      links: [
        { id: "hives", href: "/hives", label: "Hives", isActive: (pathname) => pathname === "/hives" || (pathname.startsWith("/hives/") && pathname !== "/hives/import") },
        { id: "hive-template-import", href: "/hives/import", label: "Import hive template" },
        {
          id: "global-settings",
          href: "/settings",
          label: "Global Settings",
          isActive: (pathname) => pathname === "/settings",
        },
        {
          id: "adapter-settings",
          href: "/settings/adapters",
          label: "Adapters",
          isActive: globalSettingsIsActive("/settings/adapters", "/setup/adapters"),
        },
        {
          id: "embedding-settings",
          href: "/settings/embeddings",
          label: "Embedding settings",
          isActive: globalSettingsIsActive("/settings/embeddings", "/setup/embeddings"),
        },
        {
          id: "work-intake-settings",
          href: "/settings/work-intake",
          label: "Work Intake Classifier",
          isActive: globalSettingsIsActive("/settings/work-intake", "/setup/work-intake"),
        },
        {
          id: "updates",
          href: "/setup/updates",
          label: "HiveWright Updates",
        },
      ],
    },
  ];
}
