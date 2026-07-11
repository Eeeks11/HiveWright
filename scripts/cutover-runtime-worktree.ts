#!/usr/bin/env tsx

function main() {
  const lockedInstall = process.env.HIVEWRIGHT_OPERATIONAL_INSTALL_ROOT ?? "the locked operational install";
  throw new Error(
    `runtime:cutover is disabled: HiveWright services must run from ${lockedInstall} via the privileged updater. Do not deploy a writable runtime worktree.`,
  );
}

main();
