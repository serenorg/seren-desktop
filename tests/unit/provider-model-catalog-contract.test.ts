// ABOUTME: Protects the local CLI model-catalog RPC across both runtime entrypoints.
// ABOUTME: Mission Control must reach the same provider handler in native and browser-local modes.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string): string {
  return readFileSync(resolve(path), "utf8");
}

describe("provider model catalog contract", () => {
  it("registers the catalog RPC in both local runtime entrypoints", () => {
    for (const path of ["bin/provider-runtime.mjs", "bin/seren-desktop.mjs"]) {
      const source = readSource(path);
      expect(source).toContain('"provider_get_model_catalog"');
      expect(source).toContain("providerHandlers.getModelCatalog");
    }
  });

  it("registers the permission catalog RPC in both local runtime entrypoints", () => {
    for (const path of ["bin/provider-runtime.mjs", "bin/seren-desktop.mjs"]) {
      const source = readSource(path);
      expect(source).toContain('"provider_get_permission_catalog"');
      expect(source).toContain("providerHandlers.getPermissionCatalog");
    }
  });
});
