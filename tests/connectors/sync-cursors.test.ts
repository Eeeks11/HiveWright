import { beforeEach, describe, expect, it } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import {
  getConnectorSyncCursor,
  markConnectorSyncFailure,
  markConnectorSyncSuccess,
  upsertConnectorSyncCursor,
} from "@/connectors/sync-cursors";

const HIVE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}, 'sync-cursor-hive', 'Sync Cursor Hive', 'digital')
  `;
});

async function insertInstall(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO connector_installs (
      hive_id, connector_slug, display_name, config, granted_scopes
    )
    VALUES (
      ${HIVE_ID}::uuid,
      'discord-webhook',
      'Cursor Test',
      ${sql.json({})},
      ${sql.json(["discord-webhook:test_connection"])}
    )
    RETURNING id
  `;
  return row.id;
}

describe("connector sync cursor helpers", () => {
  it("upserts one cursor per install and stream", async () => {
    const installId = await insertInstall();

    const first = await upsertConnectorSyncCursor(sql, {
      installId,
      stream: "messages",
      cursor: "cursor-1",
      lastSyncedAt: new Date("2026-05-24T00:00:00.000Z"),
      lastError: "old failure",
    });
    const second = await upsertConnectorSyncCursor(sql, {
      installId,
      stream: "messages",
      cursor: "cursor-2",
      lastSyncedAt: new Date("2026-05-24T01:00:00.000Z"),
      lastError: null,
    });

    expect(second.id).toBe(first.id);
    expect(second.cursor).toBe("cursor-2");
    expect(second.lastError).toBeNull();

    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM connector_sync_cursors
      WHERE install_id = ${installId} AND stream = 'messages'
    `;
    expect(count).toBe(1);
  });

  it("marks success with the next cursor and clears previous errors", async () => {
    const installId = await insertInstall();
    await upsertConnectorSyncCursor(sql, {
      installId,
      stream: "messages",
      cursor: "cursor-1",
      lastError: "temporary failure",
    });

    const cursor = await markConnectorSyncSuccess(sql, {
      installId,
      stream: "messages",
      cursor: "cursor-2",
      lastSyncedAt: new Date("2026-05-24T02:00:00.000Z"),
    });

    expect(cursor.cursor).toBe("cursor-2");
    expect(cursor.lastError).toBeNull();
    expect(cursor.lastSyncedAt).toEqual(new Date("2026-05-24T02:00:00.000Z"));
  });

  it("marks success without replacing the previous cursor when no cursor is supplied", async () => {
    const installId = await insertInstall();
    await markConnectorSyncSuccess(sql, {
      installId,
      stream: "messages",
      cursor: "cursor-good",
      lastSyncedAt: new Date("2026-05-24T02:00:00.000Z"),
    });

    const cursor = await markConnectorSyncSuccess(sql, {
      installId,
      stream: "messages",
      lastSyncedAt: new Date("2026-05-24T03:00:00.000Z"),
    });

    expect(cursor.cursor).toBe("cursor-good");
    expect(cursor.lastError).toBeNull();
    expect(cursor.lastSyncedAt).toEqual(new Date("2026-05-24T03:00:00.000Z"));
  });

  it("marks failure without replacing the previous cursor by default", async () => {
    const installId = await insertInstall();
    await markConnectorSyncSuccess(sql, {
      installId,
      stream: "messages",
      cursor: "cursor-good",
      lastSyncedAt: new Date("2026-05-24T02:00:00.000Z"),
    });

    const cursor = await markConnectorSyncFailure(sql, {
      installId,
      stream: "messages",
      lastError: "api token=secret-token failed",
    });

    expect(cursor.cursor).toBe("cursor-good");
    expect(cursor.lastError).toBe("api token=[REDACTED] failed");
    expect(cursor.lastSyncedAt).toEqual(new Date("2026-05-24T02:00:00.000Z"));
  });

  it("can explicitly store a failure cursor when the connector provides one", async () => {
    const installId = await insertInstall();
    await markConnectorSyncSuccess(sql, {
      installId,
      stream: "messages",
      cursor: "cursor-good",
    });

    const cursor = await markConnectorSyncFailure(sql, {
      installId,
      stream: "messages",
      cursor: "cursor-failed-page",
      lastError: "page failed",
    });

    expect(cursor.cursor).toBe("cursor-failed-page");
    expect(cursor.lastError).toBe("page failed");
  });

  it("returns null for missing cursors", async () => {
    const installId = await insertInstall();

    await expect(getConnectorSyncCursor(sql, {
      installId,
      stream: "messages",
    })).resolves.toBeNull();
  });
});
