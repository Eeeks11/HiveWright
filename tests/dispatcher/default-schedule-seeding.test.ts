import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("dispatcher default schedule seeding", () => {
  it("passes hive kind into boot-time default schedule backfill", async () => {
    const source = await readFile(join(process.cwd(), "src/dispatcher/index.ts"), "utf8");

    expect(source).toMatch(/SELECT\s+id,\s+name,\s+description,\s+kind\s+FROM\s+hives/);
    expect(source).toMatch(/seedDefaultSchedules\(this\.sql, h\)/);
  });
});
