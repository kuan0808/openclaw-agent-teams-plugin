import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    testTimeout: 900_000,     // 15 min per test (full lifecycle with LLM calls + subagent work)
    hookTimeout: 180_000,     // gateway stop/clean/start can take longer than a normal unit-test hook
    fileParallelism: false,   // run test files sequentially (shared gateway state)
    globalSetup: ["tests/e2e/global-setup.ts"],
  },
});
