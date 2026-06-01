import { describe, expect, it } from "vitest";
import { defaultLocalCandidates } from "./test-db-config";

describe("defaultLocalCandidates", () => {
  it("includes the managed local Postgres instance used by npm test", () => {
    const candidates = defaultLocalCandidates({
      HOME: "/home/test",
      USER: "developer",
      HIVEWRIGHT_EMBEDDED_POSTGRES_PORT: "56565",
      HIVEWRIGHT_EMBEDDED_POSTGRES_USER: "hivewright_test_user",
      HIVEWRIGHT_EMBEDDED_POSTGRES_PASSWORD: "secret",
    });

    expect(candidates).toContainEqual({
      adminUrl: "postgresql://hivewright_test_user:secret@127.0.0.1:56565/postgres",
      testUrl: "postgresql://hivewright_test_user:secret@127.0.0.1:56565/hivewrightv2_test",
      databaseName: "hivewrightv2_test",
      source: "auto",
    });
  });
});
