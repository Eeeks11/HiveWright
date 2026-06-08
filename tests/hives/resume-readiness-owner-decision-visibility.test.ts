import { beforeEach, describe, expect, it } from "vitest";
import { getHiveResumeReadiness } from "@/hives/resume-readiness";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE = "eeeeeeee-0000-4000-8000-000000000042";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE}, 'resume-owner-inbox', 'Resume Owner Inbox', 'digital')
  `;
});

describe("getHiveResumeReadiness — owner decision visibility alignment", () => {
  it("counts release-scan owner decisions as pending resume blockers", async () => {
    await sql`
      INSERT INTO decisions (
        hive_id, title, context, recommendation, options,
        priority, status, kind
      ) VALUES (
        ${HIVE}::uuid,
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

    const readiness = await getHiveResumeReadiness(sql, {
      hiveId: HIVE,
      creationPause: {
        paused: true,
        reason: "Manual recovery",
        pausedBy: "owner",
        updatedAt: "2026-06-08T00:00:00.000Z",
        operatingState: "paused",
        pausedScheduleIds: [],
      },
    });

    expect(readiness.counts.pendingDecisions).toBe(1);
    expect(readiness.blockers).toContainEqual(expect.objectContaining({
      code: "pending_decisions",
      count: 1,
    }));
  });
});
