// ABOUTME: Contract guards for the live model-discovery network path.
// ABOUTME: Discovery and routing must share the SerenModels publisher catalog.

import { describe, expect, it } from "vitest";
import { readSource } from "./source-text";

const modelsSource = readSource("src/services/models.ts");
const selectorSource = readSource("src/components/chat/ModelSelector.tsx");
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

describe("#3683 model catalog network contract", () => {
  it("serves the searchable catalog from the live SerenModels publisher", () => {
    // Search must only offer IDs that `POST /publishers/seren-models/
    // chat/completions` can route: the publisher's advertised catalog.
    // A broader discovery source made searched selections 404 on send.
    expect(modelsSource).toContain("getLiveSerenModelCatalog()");
    expect(modelsSource).not.toMatch(/openrouter/i);
    // No hardcoded fallback list may reintroduce unroutable IDs.
    expect(modelsSource).not.toContain("getDefaultModels");
  });

  it("keeps the chat picker's search inside the live catalog list", () => {
    expect(selectorSource).not.toMatch(/openrouter/i);
    expect(selectorSource).toContain("getLiveSerenModelCatalog");
  });

  it("does not grant packaged builds access to retired discovery hosts", () => {
    const httpPermission = capabilities.permissions.find(
      (permission) =>
        typeof permission !== "string" &&
        permission.identifier === "http:default",
    );
    const allowedUrls =
      typeof httpPermission !== "string"
        ? (httpPermission?.allow?.map((entry) => entry.url) ?? [])
        : [];

    expect(allowedUrls).toContain("https://api.serendb.com/**");
    expect(allowedUrls.join(" ")).not.toMatch(/openrouter/i);
    expect(tauriConfig.app.security.csp).toContain("https://api.serendb.com");
    expect(tauriConfig.app.security.csp).not.toMatch(/openrouter/i);
  });
});
