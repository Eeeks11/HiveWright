import type { DispatcherHeartbeatRecord } from "@/dispatcher/heartbeat";

export type DispatcherHeartbeatBuildHashStatus =
  | "matches_current_runtime"
  | "differs_from_current_runtime"
  | "current_runtime_build_hash_missing"
  | "dispatcher_heartbeat_build_hash_missing";

export interface DispatcherHeartbeatBuildHashMetadata {
  buildHashScope: "dispatcher_heartbeat";
  buildHashStatus: DispatcherHeartbeatBuildHashStatus;
  currentRuntimeBuildHash: string | null;
  buildHashInterpretation: string;
}

export type DispatcherHeartbeatWithBuildHashMetadata = DispatcherHeartbeatRecord & DispatcherHeartbeatBuildHashMetadata;

export function summarizeDispatcherHeartbeatBuildHash(
  heartbeat: Pick<DispatcherHeartbeatRecord, "buildHash">,
  runtimeBuildHash: string | null,
): DispatcherHeartbeatBuildHashMetadata {
  const buildHashStatus = classifyDispatcherHeartbeatBuildHash(heartbeat.buildHash, runtimeBuildHash);
  return {
    buildHashScope: "dispatcher_heartbeat",
    buildHashStatus,
    currentRuntimeBuildHash: runtimeBuildHash,
    buildHashInterpretation: dispatcherHeartbeatBuildHashInterpretation(buildHashStatus),
  };
}

export function attachDispatcherHeartbeatBuildHashMetadata(
  heartbeat: DispatcherHeartbeatRecord,
  runtimeBuildHash: string | null,
): DispatcherHeartbeatWithBuildHashMetadata {
  return {
    ...heartbeat,
    ...summarizeDispatcherHeartbeatBuildHash(heartbeat, runtimeBuildHash),
  };
}

function classifyDispatcherHeartbeatBuildHash(
  dispatcherBuildHash: string | null,
  runtimeBuildHash: string | null,
): DispatcherHeartbeatBuildHashStatus {
  if (!runtimeBuildHash) return "current_runtime_build_hash_missing";
  if (!dispatcherBuildHash) return "dispatcher_heartbeat_build_hash_missing";
  return dispatcherBuildHash === runtimeBuildHash
    ? "matches_current_runtime"
    : "differs_from_current_runtime";
}

function dispatcherHeartbeatBuildHashInterpretation(status: DispatcherHeartbeatBuildHashStatus): string {
  switch (status) {
    case "matches_current_runtime":
      return "dispatcherHeartbeat.buildHash matches currentRuntimeBuildHash and can be treated as current dispatcher-runtime identity for this telemetry capture.";
    case "differs_from_current_runtime":
      return "dispatcherHeartbeat.buildHash is cached dispatcher heartbeat evidence from a different build; use currentRuntimeBuildHash/improvementScanEvidence.runtimeBuildHash for current deployed runtime identity.";
    case "current_runtime_build_hash_missing":
      return "Current runtime build identity could not be resolved; do not use dispatcherHeartbeat.buildHash as a substitute for publication or improvement-scan routing.";
    case "dispatcher_heartbeat_build_hash_missing":
      return "Dispatcher heartbeat did not report a build hash; use currentRuntimeBuildHash/improvementScanEvidence.runtimeBuildHash for current deployed runtime identity.";
  }
}
