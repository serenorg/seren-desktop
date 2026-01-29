import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "openapi/openapi.json",
  output: {
    path: "src/api/generated",
    format: "prettier",
  },
  plugins: [
    "@hey-api/typescript",
    "@hey-api/sdk",
    {
      name: "@hey-api/client-fetch",
      runtimeConfigPath: "../client-config",
    },
  ],
});
