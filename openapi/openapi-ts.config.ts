import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: [
    "./openapi/openapi.json",
    "./openapi/openapi-seren-db.json",
    "./openapi/openapi-seren-cloud.json",
  ],
  output: [
    {
      path: "src/api/generated/seren-core",
      format: "prettier",
    },
    {
      path: "src/api/generated/seren-db",
      format: "prettier",
    },
    {
      path: "src/api/generated/seren-cloud",
      format: "prettier",
    },
  ],
  plugins: [
    "@hey-api/typescript",
    "@hey-api/sdk",
    {
      name: "@hey-api/client-fetch",
      runtimeConfigPath: "../../client-config",
    },
  ],
});
