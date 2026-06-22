import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    fileParallelism: false,
    include: ["src/operating-loops/runner.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.worktrees/**", "**/.claude/worktrees/**"],
    env: {
      AUTH_SECRET: "vitest-auth-secret",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
