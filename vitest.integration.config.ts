import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/integration.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 15_000,
    teardownTimeout: 15_000,
  },
});
