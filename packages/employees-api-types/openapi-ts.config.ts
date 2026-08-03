import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: [
    "./packages/employees-api-types/openapi/seren-core.json",
    "./packages/employees-api-types/openapi/seren-cloud.json",
    "./packages/employees-api-types/openapi/seren-memory.json",
  ],
  output: [
    {
      path: "packages/employees-api-types/src/generated/seren-core",
    },
    {
      path: "packages/employees-api-types/src/generated/seren-cloud",
    },
    {
      path: "packages/employees-api-types/src/generated/seren-memory",
    },
  ],
  plugins: ["@hey-api/typescript"],
});
