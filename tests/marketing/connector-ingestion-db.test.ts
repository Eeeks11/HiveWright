import { beforeEach, describe, expect, it } from "vitest";
import { persistMarketingConnectorMetricSnapshots } from "../../src/marketing-os/connector-ingestion";
import { createFixtureNamespace, testSql as sql, truncateAll } from "../_lib/test-db";

const SYNC_RESULT = {
  stream: "paid_ads",
  items: [
    {
      stream: "paid_ads",
      externalId: "google-ads:campaign-1:2026-06-16",
      occurredAt: "2026-06-16T03:00:00.000Z",
      payload: {
        adSpendCents: 42000,
        leads: 12,
        qualifiedLeads: 7,
        bookings: 3,
        sales: 1,
      },
    },
  ],
};

describe("persistMarketingConnectorMetricSnapshots against Postgres", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("upserts connector metric snapshots against the partial connector/external unique index", async () => {
    const fixture = createFixtureNamespace("connector-metric-upsert");
    const hiveId = fixture.uuid("hive");

    await sql`
      INSERT INTO hives (id, slug, name, type)
      VALUES (${hiveId}, ${fixture.slug("hive")}, 'Connector Metric Hive', 'digital')
    `;

    const [install] = await sql<{ id: string }[]>`
      INSERT INTO connector_installs (hive_id, connector_slug, display_name, config, granted_scopes, status)
      VALUES (${hiveId}, 'google-ads', 'Google Ads', '{}'::jsonb, '[]'::jsonb, 'active')
      RETURNING id
    `;

    await persistMarketingConnectorMetricSnapshots(sql, {
      hiveId,
      connectorInstallId: install.id,
      sourceConnector: "google-ads",
      results: [SYNC_RESULT],
      syncedAt: new Date("2026-06-16T03:05:00.000Z"),
    });

    await persistMarketingConnectorMetricSnapshots(sql, {
      hiveId,
      connectorInstallId: install.id,
      sourceConnector: "google-ads",
      results: [
        {
          ...SYNC_RESULT,
          items: [
            {
              ...SYNC_RESULT.items[0],
              payload: {
                ...SYNC_RESULT.items[0].payload,
                adSpendCents: 43000,
                leads: 13,
              },
            },
          ],
        },
      ],
      syncedAt: new Date("2026-06-16T04:05:00.000Z"),
    });

    const rows = await sql<{ row_count: number; values: Record<string, number> }[]>`
      SELECT
        COUNT(*) OVER ()::int AS row_count,
        values
      FROM marketing_metric_snapshots
      WHERE hive_id = ${hiveId}
        AND connector_install_id = ${install.id}
        AND source_connector = 'google-ads'
        AND source_stream = 'paid_ads'
        AND external_id = 'google-ads:campaign-1:2026-06-16'
      LIMIT 1
    `;

    expect(rows[0]).toEqual({
      row_count: 1,
      values: expect.objectContaining({
        ad_spend_cents: 43000,
        leads: 13,
        qualified_leads: 7,
        bookings: 3,
        sales: 1,
      }),
    });
  });
});
