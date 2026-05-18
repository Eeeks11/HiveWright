import { describe, expect, it } from "vitest";
import {
  getCurrentSkillWriteOrigin,
  isAgentCreatedSkill,
  normalizeSkillWriteOrigin,
  withAsyncSkillWriteOrigin,
  withSkillWriteOrigin,
} from "../../src/skills/provenance";

describe("skill provenance", () => {
  it("defaults foreground writes to user ownership", () => {
    expect(getCurrentSkillWriteOrigin()).toBe("user");
    expect(normalizeSkillWriteOrigin(undefined)).toBe("user");
    expect(normalizeSkillWriteOrigin("foreground")).toBe("user");
  });

  it("classifies only autonomous origins as curator-manageable", () => {
    expect(isAgentCreatedSkill("agent")).toBe(true);
    expect(isAgentCreatedSkill("background_review")).toBe(true);
    expect(isAgentCreatedSkill("user")).toBe(false);
    expect(isAgentCreatedSkill("system")).toBe(false);
  });

  it("scopes write origin through sync and async contexts", async () => {
    expect(withSkillWriteOrigin("background_review", () => getCurrentSkillWriteOrigin())).toBe("background_review");
    await expect(withAsyncSkillWriteOrigin("agent", async () => getCurrentSkillWriteOrigin())).resolves.toBe("agent");
    expect(getCurrentSkillWriteOrigin()).toBe("user");
  });
});
