#!/usr/bin/env tsx

function main() {
  throw new Error(
    "runtime:cutover is disabled: HiveWright services must run from the locked operational install " +
      "/home/trent/apps/HiveWright via the privileged updater. Do not deploy a writable runtime worktree.",
  );
}

main();
