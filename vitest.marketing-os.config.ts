import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    fileParallelism: false,
    include: [
      "src/marketing-os/**/*.test.ts",
      "src/sales-os/**/*.test.ts",
      "src/app/api/marketing/**/*.test.ts",
      "src/app/api/sales/**/*.test.ts",
      "src/navigation/dashboard-navigation.test.ts",
    ],
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
