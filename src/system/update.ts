export type UpdateState =
  | "current"
  | "update-available"
  | "blocked-dirty-worktree"
  | "blocked-local-ahead"
  | "blocked-diverged"
  | "locked-install-status-suppressed"
  | "not-configured"
  | "unknown";

export type GitRelation = "current" | "behind" | "ahead" | "diverged" | "unknown";

export type GitUpdateSnapshot = {
  packageVersion: string;
  currentCommit: string | null;
  upstreamCommit: string | null;
  remoteUrl: string | null;
  branch: string | null;
  dirty: boolean;
  relation?: GitRelation;
};

export type UpdateStatus = {
  currentVersion: string;
  currentCommit: string | null;
  upstreamCommit: string | null;
  remoteUrl: string | null;
  branch: string | null;
  dirty: boolean;
  updateAvailable: boolean;
  state: UpdateState;
  message: string;
};

export type UpdatePlanOptions = {
  apply?: boolean;
  restart?: boolean;
};

export type UpdatePlan = {
  allowed: boolean;
  commands: string[];
  message: string;
};

export function parseUpdateStatus(snapshot: GitUpdateSnapshot): UpdateStatus {
  if (!snapshot.remoteUrl || !snapshot.branch || !snapshot.currentCommit) {
    return {
      currentVersion: snapshot.packageVersion,
      currentCommit: snapshot.currentCommit,
      upstreamCommit: snapshot.upstreamCommit,
      remoteUrl: snapshot.remoteUrl,
      branch: snapshot.branch,
      dirty: snapshot.dirty,
      updateAvailable: false,
      state: "not-configured",
      message: "This install is not connected to a Git remote/upstream, so HiveWright cannot check for updates automatically.",
    };
  }

  if (snapshot.dirty) {
    return {
      currentVersion: snapshot.packageVersion,
      currentCommit: snapshot.currentCommit,
      upstreamCommit: snapshot.upstreamCommit,
      remoteUrl: snapshot.remoteUrl,
      branch: snapshot.branch,
      dirty: snapshot.dirty,
      updateAvailable: Boolean(
        snapshot.upstreamCommit && snapshot.upstreamCommit !== snapshot.currentCommit,
      ),
      state: "blocked-dirty-worktree",
      message: "Local changes are present. Commit, stash, or discard them before running an automatic update.",
    };
  }

  if (!snapshot.upstreamCommit) {
    return {
      currentVersion: snapshot.packageVersion,
      currentCommit: snapshot.currentCommit,
      upstreamCommit: snapshot.upstreamCommit,
      remoteUrl: snapshot.remoteUrl,
      branch: snapshot.branch,
      dirty: snapshot.dirty,
      updateAvailable: false,
      state: "unknown",
      message: "HiveWright could not resolve the upstream commit for this branch.",
    };
  }

  const relation = snapshot.relation ?? (snapshot.upstreamCommit === snapshot.currentCommit ? "current" : "behind");
  if (relation === "ahead") {
    return {
      currentVersion: snapshot.packageVersion,
      currentCommit: snapshot.currentCommit,
      upstreamCommit: snapshot.upstreamCommit,
      remoteUrl: snapshot.remoteUrl,
      branch: snapshot.branch,
      dirty: snapshot.dirty,
      updateAvailable: false,
      state: "blocked-local-ahead",
      message: "This install has local commits that are not on the configured Git remote. Publish or reset them before using automatic updates.",
    };
  }
  if (relation === "diverged") {
    return {
      currentVersion: snapshot.packageVersion,
      currentCommit: snapshot.currentCommit,
      upstreamCommit: snapshot.upstreamCommit,
      remoteUrl: snapshot.remoteUrl,
      branch: snapshot.branch,
      dirty: snapshot.dirty,
      updateAvailable: true,
      state: "blocked-diverged",
      message: "This install and the configured Git remote have diverged. Automatic fast-forward update is blocked until the local commits are reconciled.",
    };
  }

  const updateAvailable = relation === "behind" || snapshot.upstreamCommit !== snapshot.currentCommit;
  return {
    currentVersion: snapshot.packageVersion,
    currentCommit: snapshot.currentCommit,
    upstreamCommit: snapshot.upstreamCommit,
    remoteUrl: snapshot.remoteUrl,
    branch: snapshot.branch,
    dirty: snapshot.dirty,
    updateAvailable,
    state: updateAvailable ? "update-available" : "current",
    message: updateAvailable
      ? "A newer HiveWright commit is available from the configured Git remote."
      : "HiveWright is current with the configured Git remote.",
  };
}

export function buildUpdatePlan(status: UpdateStatus, options: UpdatePlanOptions = {}): UpdatePlan {
  if (!options.apply) {
    return {
      allowed: true,
      commands: ["git fetch --tags", "git status --short --branch"],
      message: "Check-only mode. No update commands will be applied.",
    };
  }

  if (status.state === "not-configured") {
    return { allowed: false, commands: [], message: status.message };
  }

  if (status.dirty || status.state === "blocked-local-ahead" || status.state === "blocked-diverged") {
    return { allowed: false, commands: [], message: status.message };
  }

  if (!status.updateAvailable) {
    return { allowed: false, commands: [], message: "No update is currently available." };
  }

  const commands = [
    "git pull --ff-only",
    "npm install",
    "npm run db:migrate:app",
    "npm run build:runtime",
    "npm run build:dispatcher",
  ];

  if (options.restart) {
    commands.push("systemctl --user restart hivewright-dashboard hivewright-dispatcher");
  }

  return {
    allowed: true,
    commands,
    message: options.restart
      ? "Update can be applied and HiveWright services will be restarted afterwards."
      : "Update can be applied. Restart HiveWright services afterwards to run the new build.",
  };
}
