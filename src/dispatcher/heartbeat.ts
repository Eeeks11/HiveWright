import { hostname } from "node:os";
import type { Sql } from "postgres";

export type DispatcherHeartbeatState = "fresh" | "stale" | "missing";

export type DispatcherHeartbeatRecord = {
  state: DispatcherHeartbeatState;
  dispatcherId: string;
  pid: number | null;
  hostId: string | null;
  version: string | null;
  buildHash: string | null;
  lastHeartbeatAt: string | null;
  ageMs: number | null;
};

export type RecordDispatcherHeartbeatInput = {
  dispatcherId?: string;
  pid?: number;
  hostId?: string;
  version?: string | null;
  buildHash?: string | null;
  now?: Date;
};

const DEFAULT_DISPATCHER_ID = "default";

export function defaultDispatcherId(): string {
  return process.env.HIVEWRIGHT_DISPATCHER_ID?.trim() || DEFAULT_DISPATCHER_ID;
}

export function dispatcherVersion(): string | null {
  return process.env.npm_package_version ?? null;
}

export function dispatcherBuildHash(): string | null {
  return process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.HIVEWRIGHT_BUILD_HASH ?? null;
}

export async function recordDispatcherHeartbeat(
  sql: Sql,
  input: RecordDispatcherHeartbeatInput = {},
): Promise<void> {
  const dispatcherId = input.dispatcherId ?? defaultDispatcherId();
  const pid = input.pid ?? process.pid;
  const hostId = input.hostId ?? hostname();
  const version = input.version ?? dispatcherVersion();
  const buildHash = input.buildHash ?? dispatcherBuildHash();
  const now = input.now ?? new Date();

  await sql`
    INSERT INTO dispatcher_heartbeats (
      dispatcher_id, pid, host_id, version, build_hash, status, last_heartbeat_at, started_at
    )
    VALUES (
      ${dispatcherId}, ${pid}, ${hostId}, ${version}, ${buildHash}, 'running', ${now}, ${now}
    )
    ON CONFLICT (dispatcher_id) DO UPDATE
    SET pid = EXCLUDED.pid,
        host_id = EXCLUDED.host_id,
        version = EXCLUDED.version,
        build_hash = EXCLUDED.build_hash,
        status = 'running',
        last_heartbeat_at = EXCLUDED.last_heartbeat_at
  `;
}

export async function loadDispatcherHeartbeatStatus(
  sql: Sql,
  input: {
    dispatcherId?: string;
    now?: Date;
    staleAfterMs?: number;
  } = {},
): Promise<DispatcherHeartbeatRecord> {
  const dispatcherId = input.dispatcherId ?? defaultDispatcherId();
  const now = input.now ?? new Date();
  const staleAfterMs = input.staleAfterMs ?? 120_000;
  const [row] = await sql<{
    dispatcher_id: string;
    pid: number;
    host_id: string;
    version: string | null;
    build_hash: string | null;
    last_heartbeat_at: Date;
  }[]>`
    SELECT dispatcher_id, pid, host_id, version, build_hash, last_heartbeat_at
    FROM dispatcher_heartbeats
    WHERE dispatcher_id = ${dispatcherId}
    LIMIT 1
  `;

  if (!row) {
    return {
      state: "missing",
      dispatcherId,
      pid: null,
      hostId: null,
      version: null,
      buildHash: null,
      lastHeartbeatAt: null,
      ageMs: null,
    };
  }

  const ageMs = Math.max(0, now.getTime() - row.last_heartbeat_at.getTime());
  return {
    state: ageMs > staleAfterMs ? "stale" : "fresh",
    dispatcherId: row.dispatcher_id,
    pid: Number(row.pid),
    hostId: row.host_id,
    version: row.version,
    buildHash: row.build_hash,
    lastHeartbeatAt: row.last_heartbeat_at.toISOString(),
    ageMs,
  };
}
