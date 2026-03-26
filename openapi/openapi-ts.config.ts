import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: [
    "./openapi/openapi.json",
    "./openapi/openapi-seren-db.json",
    "./openapi/openapi-seren-cloud.json",
    "./openapi/openapi-seren-private-models.json",
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
    {
      path: "src/api/generated/seren-private-models",
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
