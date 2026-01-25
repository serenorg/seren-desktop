// ABOUTME: Vitest configuration for unit and integration tests.
// ABOUTME: Uses node environment for pure function tests, path aliases match tsconfig.

import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
