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
      id: "outcome-1",
      goal_id: GOAL_ID,
      hive_id: HIVE_ID,
      goal_title: "ASX watchlist screen",
      summary: "Final screen is ready for review.",
      why_it_matters: "The owner can inspect the finished screen instead of task logs.",
      recommended_next_action: "Open the final screen and accept it if ready.",
      impact_statement: "Project hive impact: moves the next shippable artifact into owner review.",
      review_state: "new",
      evidence: { workProductIds: ["wp-1", "wp-2"] },
      primary_work_product_id: "wp-1",
      primary_open_url: "/deliverables/wp-1/open",
      primary_artifact_title: "Landing page",
      primary_artifact_render_mode: "html",
      created_at: new Date("2026-05-17T02:00:00.000Z"),
    });

    expect(outcome).toEqual({
      id: "outcome-1",
      goalId: GOAL_ID,
      hiveId: HIVE_ID,
      goalTitle: "ASX watchlist screen",
      summary: "Final screen is ready for review.",
      whyItMatters: "The owner can inspect the finished screen instead of task logs.",
      recommendedNextAction: "Open the final screen and accept it if ready.",
      impactStatement: "Project hive impact: moves the next shippable artifact into owner review.",
      status: "new",
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
      id: "outcome-2",
      goal_id: GOAL_ID,
      hive_id: HIVE_ID,
      goal_title: "Goal title",
      summary: "",
      why_it_matters: "",
      recommended_next_action: "",
      impact_statement: "",
      review_state: "new",
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

  it("lists durable owner outcomes and chooses a verified artifact from completion evidence", async () => {
    const rows = [
      {
        id: "outcome-new",
        goal_id: GOAL_ID,
        hive_id: HIVE_ID,
        goal_title: "New completed goal",
        summary: "Owner handoff",
        why_it_matters: "This handoff has durable owner review state.",
        recommended_next_action: "Open and accept the handoff.",
        impact_statement: "Business hive impact: validates the owner-facing outcome.",
        review_state: "accepted",
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
    expect(outcomes[0]?.id).toBe("outcome-new");
    expect(outcomes[0]?.status).toBe("accepted");
    expect(outcomes[0]?.whyItMatters).toBe("This handoff has durable owner review state.");
    expect(outcomes[0]?.recommendedNextAction).toBe("Open and accept the handoff.");
    expect(outcomes[0]?.impactStatement).toBe("Business hive impact: validates the owner-facing outcome.");
    expect(outcomes[0]?.evidenceWorkProductIds).toEqual(["wp-a", "wp-b", "wp-c"]);
    expect(outcomes[0]?.primaryOpenUrl).toBe("/deliverables/wp-b/open");

    const query = sql.mock.calls[0]?.[0].join("?") ?? "";
    expect(query).toContain("FROM owner_outcomes oo");
    expect(query).toContain("JOIN goals g ON g.id = oo.goal_id");
    expect(query).toContain("oo.review_state");
    expect(query).toContain("jsonb_array_elements_text");
    expect(query).toContain("WITH ORDINALITY");
    expect(query).toContain("JOIN work_products wp ON wp.id::text = evidence_ids.id");
    expect(query).toContain("JOIN tasks source_task ON source_task.id = wp.task_id");
    expect(query).toContain("ORDER BY oo.created_at DESC");
    expect(query).toContain("wp.hive_id = oo.hive_id");
    expect(query).toContain("source_task.goal_id = oo.goal_id");
    expect(query).not.toContain("wp.source_url");
    expect(query).toContain("wp.public_url ~* '^https?://'");
    expect(query).toContain("wp.artifact_kind = 'final_artifact'");
    expect(query).toContain("WHEN wp.artifact_kind = 'landing_page' THEN 1");
    expect(query).toContain("WHEN wp.artifact_kind = 'image' THEN 2");
    expect(query).toContain("WHEN wp.artifact_kind = 'document' THEN 3");
    expect(query).toContain("WHEN wp.artifact_kind = 'report' THEN 4");
    expect(query).toContain("doctor|supervisor|peer[- ]?review");
    expect(query).not.toContain("checklist|report)");
  });

  it("counts owner outcomes independently from the latest-outcomes limit", async () => {
    const sql = createSql([{ count: "11" }]);

    const count = await countOwnerOutcomes(sql as never, { hiveId: HIVE_ID });

    expect(count).toBe(11);
    const query = sql.mock.calls[0]?.[0].join("?") ?? "";
    expect(query).toContain("COUNT(*)::int AS count");
    expect(query).toContain("FROM owner_outcomes oo");
    expect(query).toContain("WHERE");
    expect(query).toContain("oo.review_state = 'new'");
  });
});
