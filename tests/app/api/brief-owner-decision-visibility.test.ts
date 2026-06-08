import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/brief/route";
import { testSql as sql, truncateAll } from "../../_lib/test-db";

const HIVE = "dddddddd-0000-4000-8000-000000000041";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE}, 'brief-owner-inbox', 'Brief Owner Inbox', 'digital')
  `;
});

describe("GET /api/brief — owner decision visibility alignment", () => {
  it("counts and lists release-scan owner decisions that are visible in the inbox", async () => {
    const [goal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, status)
      VALUES (${HIVE}::uuid, 'Adopt model registry updates', 'active')
      RETURNING id
    `;

    await sql`
      INSERT INTO decisions (
        hive_id, goal_id, title, context, recommendation, options,
        priority, status, kind
      ) VALUES (
        ${HIVE}::uuid,
        ${goal.id}::uuid,
        'Tier-2: review new openai model openai/gpt-6-test',
        'Release scan found a new OpenAI model and verified pricing.',
        'Approve to queue a dev-agent patch task for the model registry.',
        ${sql.json({
          kind: "release_scan_model_proposal",
          modelProposal: {
            source: "release-scan",
            provider: "openai",
            modelId: "openai/gpt-6-test",
          },
        })},
        'urgent',
        'pending',
        'release_scan_model_proposal'
      )
    `;

    const res = await GET(new Request(`http://localhost/api/brief?hiveId=${HIVE}`));
    expect(res.status).toBe(200);

    const body = await res.json() as {
      data: {
        flags: {
          pendingDecisions: number;
          totalPendingDecisions: number;
          waitingGoals: number;
        };
        pendingDecisions: Array<{ title: string }>;
        goals: Array<{ id: string; health: string; pendingDecisions: number }>;
      };
    };

    expect(body.data.flags.pendingDecisions).toBe(1);
    expect(body.data.flags.totalPendingDecisions).toBe(1);
    expect(body.data.flags.waitingGoals).toBe(1);
    expect(body.data.pendingDecisions.map((decision) => decision.title)).toEqual([
      'Tier-2: review new openai model openai/gpt-6-test',
    ]);
    expect(body.data.goals).toContainEqual(expect.objectContaining({
      id: goal.id,
      health: "waiting_on_owner",
      pendingDecisions: 1,
    }));
  });
});
