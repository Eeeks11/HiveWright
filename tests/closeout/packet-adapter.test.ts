import { describe, expect, it } from "vitest";
import { validateCloseoutPacket, type CloseoutCanonicalMarker } from "@/closeout/packet-adapter";

const baseMarker: CloseoutCanonicalMarker = {
  terminal_status: "closed",
  final_disposition_label: "goal_completion_accepted",
  source_finding: {
    kind: "goal_appears_complete",
    key: "goal:abc123",
  },
  source_record_ref: {
    table: "goal_completions",
    id: "abc123",
  },
  storage_root_family: "db_goal_completion",
};

describe("closeout packet adapter", () => {
  it("accepts workspace deliverable manifest packets with canonical marker fields", () => {
    const result = validateCloseoutPacket({
      marker: {
        ...baseMarker,
        storage_root_family: "workspace_deliverable_manifest",
        path_family: "workspace_deliverable_manifest",
      },
    });

    expect(result).toMatchObject({ ok: true, canAutoClose: true });
  });

  it("accepts workspace work-product manifest packets", () => {
    const result = validateCloseoutPacket({
      marker: {
        ...baseMarker,
        final_disposition_label: "orphan_output_attributed",
        source_finding: {
          kind: "orphan_output",
          key: "work-product:wp_123",
        },
        source_record_ref: {
          table: "work_products",
          id: "wp_123",
        },
        storage_root_family: "workspace_work_product_manifest",
      },
    });

    expect(result).toMatchObject({ ok: true, canAutoClose: true });
  });

  it("accepts business governance packet roots", () => {
    const result = validateCloseoutPacket({
      marker: {
        ...baseMarker,
        final_disposition_label: "owner_decision_required",
        source_finding: {
          kind: "aging_decision",
          key: "decision:dec_123",
        },
        source_record_ref: {
          table: "decisions",
          id: "dec_123",
        },
        storage_root_family: "business_governance_packet",
      },
    });

    expect(result).toMatchObject({ ok: true, canAutoClose: true });
  });

  it("accepts business work-product packet roots", () => {
    const result = validateCloseoutPacket({
      marker: {
        ...baseMarker,
        final_disposition_label: "reference_only_output",
        source_finding: {
          kind: "unsatisfied_completion",
          key: "task:task_123",
        },
        source_record_ref: {
          table: "tasks",
          id: "task_123",
        },
        storage_root_family: "business_work_product_packet",
      },
    });

    expect(result).toMatchObject({ ok: true, canAutoClose: true });
  });

  it("rejects terminal packet claims missing source_finding", () => {
    const result = validateCloseoutPacket({
      marker: {
        ...baseMarker,
        source_finding: undefined,
      },
    });

    expect(result).toEqual({
      ok: false,
      canAutoClose: false,
      reviewRequired: true,
      reason: "missing_source_finding",
      legacyKind: undefined,
    });
  });

  it("rejects terminal packet claims missing source_record_ref", () => {
    const result = validateCloseoutPacket({
      marker: {
        ...baseMarker,
        source_record_ref: undefined,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      canAutoClose: false,
      reviewRequired: true,
      reason: "missing_source_record_ref",
    });
  });

  it("grandfathers unknown legacy packets into operator review without auto-close", () => {
    const result = validateCloseoutPacket({
      legacyKind: "legacy_markdown_packet",
      marker: null,
    });

    expect(result).toEqual({
      ok: false,
      canAutoClose: false,
      reviewRequired: true,
      reason: "missing_canonical_marker",
      legacyKind: "legacy_markdown_packet",
    });
  });

  it("rejects unregistered storage roots", () => {
    const result = validateCloseoutPacket({
      marker: {
        ...baseMarker,
        storage_root_family: "random_markdown_folder" as never,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      canAutoClose: false,
      reviewRequired: true,
      reason: "invalid_or_missing_storage_root_family",
    });
  });

  it("rejects unregistered path families", () => {
    const result = validateCloseoutPacket({
      marker: {
        ...baseMarker,
        path_family: "random_markdown_folder" as never,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      canAutoClose: false,
      reviewRequired: true,
      reason: "invalid_path_family",
    });
  });
});
