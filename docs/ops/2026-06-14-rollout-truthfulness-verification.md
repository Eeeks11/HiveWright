# Rollout Truthfulness Verification

Date: 2026-06-14
Route: GitHub issue [#55](https://github.com/Eeeks11/HiveWright/issues/55), PR [#67](https://github.com/Eeeks11/HiveWright/pull/67)

## Verified host state

- Privileged updater status: `sudo -n /usr/local/sbin/hivewright-operational-update status-json`
  - `state=current`
  - `currentCommit=49a9798b4d2d16f0b34f0c741f9aa24ed8367e14`
  - `upstreamCommit=49a9798b4d2d16f0b34f0c741f9aa24ed8367e14`
- Live health: `curl -sS http://127.0.0.1:3002/api/health`
  - `status=ok`
  - `buildHash=49a9798b4d2d16f0b34f0c741f9aa24ed8367e14`
- Live readiness: `curl -sS http://127.0.0.1:3002/api/readiness`
  - `status=ready`
  - `ready=true`

## Privileged updater evidence

Updater log: `/home/trent/.hivewright/logs/updates/hivewright-update-20260614-015012.log`

Tail:

```text
== verify ==
active
active
pid=158176 cwd=/home/trent/apps/HiveWright
pid=158205 cwd=/home/trent/apps/HiveWright
curl: (7) Failed to connect to 127.0.0.1 port 3002 after 0 ms: Couldn't connect to server
dashboard_health_attempt=1/15 dashboard_http=000000
dashboard_health_attempt=2/15 dashboard_http=200
dashboard_http=200
dashboard_build_hash=49a9798b4d2d16f0b34f0c741f9aa24ed8367e14
cutover_file=/home/trent/.hivewright/logs/deployments/latest-runtime-cutover.json
head_after=49a9798b4d2d16f0b34f0c741f9aa24ed8367e14
completed=2026-06-14T01:52:28+10:00
```

The first dashboard probe failed during restart recovery, but the updater did not finish there. It retried, recovered to HTTP 200, matched the live build hash, and only then rewrote the cutover record.

## Live process proof

Command:

```text
ps -o pid=,ppid=,user=,lstart=,cmd= -p 158176,158205
readlink /proc/158176/cwd
readlink /proc/158205/cwd
```

Output:

```text
158176 1436 trent Sun Jun 14 01:52:25 2026 npm run start -H 127.0.0.1
158205 1436 trent Sun Jun 14 01:52:25 2026 node dispatcher-bundle.js
/home/trent/apps/HiveWright
/home/trent/apps/HiveWright
```

## Cutover record proof

Path: `/home/trent/.hivewright/logs/deployments/latest-runtime-cutover.json`

```json
{
  "recordedAt": "2026-06-14T01:52:28+10:00",
  "runtimeMode": "locked-install",
  "installDir": "/home/trent/apps/HiveWright",
  "runtimeRoot": "/home/trent/.hivewright",
  "envFile": "/home/trent/.hivewright/config/.env",
  "dashboardHealthUrl": "http://127.0.0.1:3002",
  "deployedCommit": "49a9798b4d2d16f0b34f0c741f9aa24ed8367e14",
  "buildHash": "49a9798b4d2d16f0b34f0c741f9aa24ed8367e14",
  "dashboard": {
    "pid": 158176,
    "cwd": "/home/trent/apps/HiveWright"
  },
  "dispatcher": {
    "pid": 158205,
    "cwd": "/home/trent/apps/HiveWright"
  }
}
```

## Route note

- The host is currently running a root-owned `/usr/local/sbin/hivewright-operational-update` copy that already contains the rollout-truthfulness logic.
- PR #67 also adds the wrapper install path so future privileged runs come from `/home/trent/apps/HiveWright/scripts/hivewright-operational-update-root.sh` after the installer is rerun post-merge.
- Issue #45 should not block this lane. Current verified evidence shows both live services run from the locked install at `/home/trent/apps/HiveWright`; re-scope #45 only if HiveWright intentionally returns to a runtime-worktree deployment model.
