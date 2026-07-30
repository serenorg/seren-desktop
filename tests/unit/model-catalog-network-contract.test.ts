// ABOUTME: Contract guards for the live model-discovery network path.
// ABOUTME: Keeps the full OpenRouter catalog reachable from packaged Tauri builds.

import { describe, expect, it } from "vitest";
import { readSource } from "./source-text";

const modelsSource = readSource("src/services/models.ts");
const capabilities = JSON.parse(
  readSource("src-tauri/capabilities/default.json"),
) as {
  permissions: Array<
    | string
    | {
        identifier: string;
        allow?: Array<{ url: string }>;
      }
  >;
};
const tauriConfig = JSON.parse(
  readSource("src-tauri/tauri.conf.json"),
) as {
  app: {
    security: {
      csp: string;
    };
  };
};

describe("model catalog network contract", () => {
  it("loads the searchable catalog from OpenRouter's full models endpoint", () => {
    expect(modelsSource).toContain(
      'const CATALOG_URL = "https://openrouter.ai/api/v1/models";',
    );
    expect(modelsSource).toContain("await appFetch(CATALOG_URL)");
    expect(modelsSource).not.toContain("/publishers/seren-models/models");
  });

  it("allows the OpenRouter catalog in packaged desktop builds", () => {
    const httpPermission = capabilities.permissions.find(
      (permission) =>
        typeof permission !== "string" &&
        permission.identifier === "http:default",
    );

    expect(
      typeof httpPermission !== "string"
        ? httpPermission?.allow?.map((entry) => entry.url)
        : [],
    ).toContain("https://openrouter.ai/**");
    expect(tauriConfig.app.security.csp).toContain(
      "connect-src 'self' ipc://localhost",
    );
    expect(tauriConfig.app.security.csp).toContain("https://openrouter.ai");
  });
});
