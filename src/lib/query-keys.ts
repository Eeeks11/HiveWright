export const queryKeys = {
  dashboard: {
    summary: (hiveId: string) => ["dashboard", "summary", hiveId] as const,
  },
  tasks: {
    active: (hiveId: string) => ["tasks", "active", hiveId] as const,
    detail: (taskId: string) => ["tasks", "detail", taskId] as const,
  },
  decisions: {
    list: (hiveId: string) => ["decisions", "list", hiveId] as const,
    listWithFilters: (
      hiveId: string,
      filters: { status?: string; kind?: string; includeInternalSystem?: boolean } = {},
    ) => ["decisions", "list", hiveId, filters] as const,
  },
  goals: {
    list: (hiveId: string) => ["goals", "list", hiveId] as const,
  },
  connectors: {
    catalog: (hiveId: string) => ["connectors", "catalog", hiveId] as const,
    installs: (hiveId: string) => ["connectors", "installs", hiveId] as const,
    actions: (installId: string) => ["connectors", "actions", installId] as const,
  },
  eaChat: {
    active: (hiveId: string) => ["ea-chat", "active", hiveId] as const,
  },
} as const;
