import {
  CLOSEOUT_FINDING_TYPES,
  FINAL_DISPOSITION_LABELS,
  STORAGE_ROOT_FAMILIES,
  TERMINAL_STATUSES,
  type CloseoutFindingType,
  type FinalDispositionLabel,
  type StorageRootFamily,
  type TerminalStatus,
} from "@/closeout/registry";

export interface CloseoutSourceFinding {
  kind: CloseoutFindingType;
  key: string;
  evidence_ref?: string;
}

export interface CloseoutSourceRecordRef {
  table: string;
  id: string;
  field?: string;
}

export interface CloseoutCanonicalMarker {
  terminal_status: TerminalStatus;
  final_disposition_label: FinalDispositionLabel;
  source_finding: CloseoutSourceFinding;
  source_record_ref: CloseoutSourceRecordRef;
  storage_root_family: StorageRootFamily;
  path_family?: StorageRootFamily;
}

export interface CloseoutPacketAdapterInput {
  marker?: Partial<CloseoutCanonicalMarker> | null;
  legacyKind?: string | null;
}

export type CloseoutPacketAdapterResult =
  | {
      ok: true;
      marker: CloseoutCanonicalMarker;
      canAutoClose: true;
    }
  | {
      ok: false;
      canAutoClose: false;
      reviewRequired: true;
      reason: string;
      legacyKind?: string | null;
    };

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function includesValue<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value as T[number]);
}

function rejectForReview(
  reason: string,
  legacyKind?: string | null,
): CloseoutPacketAdapterResult {
  return {
    ok: false,
    canAutoClose: false,
    reviewRequired: true,
    reason,
    legacyKind,
  };
}

export function validateCloseoutPacket(
  input: CloseoutPacketAdapterInput,
): CloseoutPacketAdapterResult {
  const marker = input.marker;

  if (!marker) {
    return rejectForReview("missing_canonical_marker", input.legacyKind);
  }

  if (!includesValue(TERMINAL_STATUSES, marker.terminal_status)) {
    return rejectForReview("invalid_or_missing_terminal_status", input.legacyKind);
  }

  if (!includesValue(FINAL_DISPOSITION_LABELS, marker.final_disposition_label)) {
    return rejectForReview("invalid_or_missing_final_disposition_label", input.legacyKind);
  }

  if (!includesValue(STORAGE_ROOT_FAMILIES, marker.storage_root_family)) {
    return rejectForReview("invalid_or_missing_storage_root_family", input.legacyKind);
  }

  if (
    marker.path_family !== undefined &&
    !includesValue(STORAGE_ROOT_FAMILIES, marker.path_family)
  ) {
    return rejectForReview("invalid_path_family", input.legacyKind);
  }

  if (!marker.source_finding) {
    return rejectForReview("missing_source_finding", input.legacyKind);
  }

  if (!includesValue(CLOSEOUT_FINDING_TYPES, marker.source_finding.kind)) {
    return rejectForReview("invalid_source_finding_kind", input.legacyKind);
  }

  if (!isNonEmptyString(marker.source_finding.key)) {
    return rejectForReview("missing_source_finding_key", input.legacyKind);
  }

  if (!marker.source_record_ref) {
    return rejectForReview("missing_source_record_ref", input.legacyKind);
  }

  if (!isNonEmptyString(marker.source_record_ref.table)) {
    return rejectForReview("missing_source_record_ref_table", input.legacyKind);
  }

  if (!isNonEmptyString(marker.source_record_ref.id)) {
    return rejectForReview("missing_source_record_ref_id", input.legacyKind);
  }

  return {
    ok: true,
    marker: marker as CloseoutCanonicalMarker,
    canAutoClose: true,
  };
}
