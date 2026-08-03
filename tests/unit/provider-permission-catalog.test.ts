// ABOUTME: Protects Mission Control's provider-native permission catalog.
// ABOUTME: Ensures every displayed mode and effective default comes from the runtime contract.

import { describe, expect, it, vi } from "vitest";
// @ts-ignore - browser-local provider runtime is plain ESM.
import { createProviderHandlers } from "../../bin/browser-local/providers.mjs";

const settings = {
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  networkEnabled: true,
};

describe("provider permission catalog", () => {
  const handlers = createProviderHandlers({ emit: vi.fn() });

  it.each([
    [
      "claude-code",
      "default",
      ["default", "acceptEdits", "plan", "bypassPermissions"],
    ],
    ["codex", "auto", ["auto", "ask"]],
    ["gemini", "default", ["default", "accept-edits", "plan", "yolo"]],
    [
      "grok",
      "default",
      ["default", "acceptEdits", "dontAsk", "bypassPermissions", "plan"],
    ],
    ["claude-codex", "auto", ["auto", "ask"]],
    ["lmstudio", "ask", ["ask", "auto"]],
  ])(
    "returns every %s runtime mode",
    (agentType, defaultModeId, expectedModeIds) => {
      const catalog = handlers.getPermissionCatalog({ agentType, ...settings });
      expect(catalog.defaultModeId).toBe(defaultModeId);
      expect(catalog.modes.map((mode: { modeId: string }) => mode.modeId)).toEqual(
        expectedModeIds,
      );
      expect(
        catalog.modes.every(
          (mode: { name?: string; description?: string }) =>
            Boolean(mode.name && mode.description),
        ),
      ).toBe(true);
    },
  );

  it("resolves permissive Agent Settings through each runtime's own mapping", () => {
    const permissive = {
      approvalPolicy: "never",
      sandboxMode: "full-access",
      networkEnabled: true,
    };
    expect(
      handlers.getPermissionCatalog({ agentType: "claude-code", ...permissive })
        .defaultModeId,
    ).toBe("bypassPermissions");
    expect(
      handlers.getPermissionCatalog({ agentType: "gemini", ...permissive })
        .defaultModeId,
    ).toBe("yolo");
    expect(
      handlers.getPermissionCatalog({ agentType: "grok", ...permissive })
        .defaultModeId,
    ).toBe("bypassPermissions");
    expect(
      handlers.getPermissionCatalog({ agentType: "lmstudio", ...permissive })
        .defaultModeId,
    ).toBe("auto");
  });
});
