import { describe, expect, it, vi } from "vitest";
import { upsertOwnerOutcomeForCompletion } from "@/outcomes/durable";

function createSql() {
  const queries: string[] = [];
  const sql = vi.fn((strings: TemplateStringsArray) => {
    const query = strings.join("?");
    queries.push(query);
    if (query.includes("FROM goals g")) {
      return Promise.resolve([{ kind: "business", title: "Launch campaign page" }]);
    }
    if (query.includes("FROM work_products wp")) {
      return Promise.resolve([{
        id: "33333333-3333-4333-8333-333333333333",
        open_url: "/deliverables/33333333-3333-4333-8333-333333333333/open",
        title: "Final landing page",
        render_mode: "html",
      }]);
    }
    if (query.includes("INSERT INTO owner_outcomes")) {
      return Promise.resolve([{ id: "44444444-4444-4444-8444-444444444444" }]);
    }
    return Promise.resolve([]);
  });
  return Object.assign(sql, {
    json: vi.fn((value: unknown) => value),
    queries,
  });
}

describe("durable owner outcome creation", () => {
  it("selects primary work products with business-output priority before support artifacts", async () => {
    const sql = createSql();

    await upsertOwnerOutcomeForCompletion(sql as never, {
      hiveId: "11111111-1111-4111-8111-111111111111",
      goalId: "22222222-2222-4222-8222-222222222222",
      goalCompletionId: "55555555-5555-4555-8555-555555555555",
      completionSummary: "Campaign page is ready.",
      evidence: {
        workProductIds: [
          "33333333-3333-4333-8333-333333333333",
          "66666666-6666-4666-8666-666666666666",
        ],
      },
    });

    const primaryQuery = sql.queries.find((query) => query.includes("FROM work_products wp"));
    expect(primaryQuery).toContain("WHEN wp.artifact_kind = 'landing_page' THEN 1");
    expect(primaryQuery).toContain("WHEN wp.artifact_kind = 'image' THEN 2");
    expect(primaryQuery).toContain("WHEN wp.artifact_kind = 'document' THEN 3");
    expect(primaryQuery).toContain("WHEN wp.artifact_kind = 'report' THEN 4");
    expect(primaryQuery).toContain("doctor|supervisor|peer[- ]?review");
    expect(primaryQuery).not.toContain("checklist|report)");
  });
});
