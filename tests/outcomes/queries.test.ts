import { describe, expect, it, vi } from "vitest";
import { countOwnerOutcomes, listOwnerOutcomes, mapOwnerOutcomeRow, ownerOutcomeActionLabel } from "@/outcomes/queries";

const GOAL_ID = "11111111-1111-1111-1111-111111111111";
const HIVE_ID = "22222222-2222-2222-2222-222222222222";

function createSql(rows: unknown[]) {
  return vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    return Promise.resolve(Object.assign([...rows], { query, values }));
  });
}

describe("owner outcome queries", () => {
  it("maps one owner-facing outcome from a goal completion and exposes the primary artifact action", () => {
    const outcome = mapOwnerOutcomeRow({
      id: "completion-1",
      goal_id: GOAL_ID,
      hive_id: HIVE_ID,
      goal_title: "ASX watchlist screen",
      summary: "Final screen is ready for review.",
      evidence: { workProductIds: ["wp-1", "wp-2"] },
      primary_work_product_id: "wp-1",
      primary_open_url: "/deliverables/wp-1/open",
      primary_artifact_title: "Landing page",
      primary_artifact_render_mode: "html",
      created_at: new Date("2026-05-17T02:00:00.000Z"),
    });

    expect(outcome).toEqual({
      id: "completion-1",
      goalId: GOAL_ID,
      hiveId: HIVE_ID,
      goalTitle: "ASX watchlist screen",
      summary: "Final screen is ready for review.",
      status: "unread",
      createdAt: "2026-05-17T02:00:00.000Z",
      evidenceWorkProductIds: ["wp-1", "wp-2"],
      primaryWorkProductId: "wp-1",
      primaryOpenUrl: "/deliverables/wp-1/open",
      primaryDetailUrl: "/deliverables/wp-1",
      primaryArtifactTitle: "Landing page",
      primaryArtifactRenderMode: "html",
      primaryActionLabel: "View output page",
    });
  });

  it("defensively ignores malformed evidence and keeps goal review as fallback when no artifact was verified", () => {
    const outcome = mapOwnerOutcomeRow({
      id: "completion-2",
      goal_id: GOAL_ID,
      hive_id: HIVE_ID,
      goal_title: "Goal title",
      summary: "",
      evidence: { workProductIds: ["wp-1", 42, null, "wp-2"] },
      primary_work_product_id: null,
      primary_open_url: null,
      primary_artifact_title: null,
      primary_artifact_render_mode: null,
      created_at: "not-a-date",
    });

    expect(outcome.evidenceWorkProductIds).toEqual(["wp-1", "wp-2"]);
    expect(outcome.primaryWorkProductId).toBe("wp-1");
    expect(outcome.primaryOpenUrl).toBeNull();
    expect(outcome.primaryDetailUrl).toBeNull();
    expect(outcome.primaryActionLabel).toBe("Review final output");
    expect(outcome.createdAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("labels live/external artifacts as live pages", () => {
    expect(ownerOutcomeActionLabel("external_url", "https://example.com/page")).toBe("Open live page");
  });

  it("lists goal completions and chooses a verified artifact from completion evidence", async () => {
    const rows = [
      {
        id: "completion-new",
        goal_id: GOAL_ID,
        hive_id: HIVE_ID,
        goal_title: "New completed goal",
        summary: "Owner handoff",
        evidence: { workProductIds: ["wp-a", "wp-b", "wp-c"] },
        primary_work_product_id: "wp-b",
        primary_open_url: "/deliverables/wp-b/open",
        primary_artifact_title: "Final landing page",
        primary_artifact_render_mode: "html",
        created_at: new Date("2026-05-17T02:00:00.000Z"),
      },
    ];
    const sql = createSql(rows);

    const outcomes = await listOwnerOutcomes(sql as never, { hiveId: HIVE_ID, limit: 100 });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.id).toBe("completion-new");
    expect(outcomes[0]?.evidenceWorkProductIds).toEqual(["wp-a", "wp-b", "wp-c"]);
    expect(outcomes[0]?.primaryOpenUrl).toBe("/deliverables/wp-b/open");

    const query = sql.mock.calls[0]?.[0].join("?") ?? "";
    expect(query).toContain("FROM goal_completions gc");
    expect(query).toContain("JOIN goals g ON g.id = gc.goal_id");
    expect(query).toContain("jsonb_array_elements_text");
    expect(query).toContain("WITH ORDINALITY");
    expect(query).toContain("JOIN work_products wp ON wp.id::text = evidence_ids.id");
    expect(query).toContain("ORDER BY gc.created_at DESC");
    expect(query).toContain("wp.hive_id = g.hive_id");
    expect(query).toContain("EXISTS");
    expect(query).toContain("t.goal_id = gc.goal_id");
    expect(query).not.toContain("wp.source_url");
    expect(query).toContain("wp.public_url ~* '^https?://'");
    expect(query).toContain("wp.artifact_kind = 'final_artifact'");
    expect(query).toContain("qa|review|compliance|signoff|audit|rework|notes|checklist|report");
  });

  it("counts owner outcomes independently from the latest-outcomes limit", async () => {
    const sql = createSql([{ count: "11" }]);

    const count = await countOwnerOutcomes(sql as never, { hiveId: HIVE_ID });

    expect(count).toBe(11);
    const query = sql.mock.calls[0]?.[0].join("?") ?? "";
    expect(query).toContain("COUNT(*)::int AS count");
    expect(query).toContain("FROM goal_completions gc");
    expect(query).toContain("JOIN goals g ON g.id = gc.goal_id");
  });
});
