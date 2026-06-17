import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: [
    "./openapi/openapi.json",
    "./openapi/openapi-seren-db.json",
    "./openapi/openapi-seren-cloud.json",
    "./openapi/openapi-seren-private-models.json",
    "./openapi/openapi-seren-agent.json",
    "./openapi/openapi-seren-skills.json",
    "./openapi/openapi-seren-bounty.json",
  ],
  output: [
    {
      path: "src/api/generated/seren-core",
    },
    {
      path: "src/api/generated/seren-db",
    },
    {
      path: "src/api/generated/seren-cloud",
    },
    {
      path: "src/api/generated/seren-private-models",
    },
    {
      path: "src/api/generated/seren-agent",
    },
    {
      path: "src/api/generated/seren-skills",
    },
    {
      path: "src/api/generated/seren-bounty",
    },
  ],
  plugins: [
    "@hey-api/typescript",
    "@hey-api/sdk",
    {
      name: "@tanstack/solid-query",
      queryOptions: true,
      mutationOptions: true,
    },
    {
      name: "@hey-api/client-fetch",
      runtimeConfigPath: "@/api/client-config",
    },
  ],
});
