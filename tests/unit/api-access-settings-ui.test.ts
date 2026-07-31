// ABOUTME: Static contract for the Settings API Access repair surface (#3520).
// ABOUTME: Pins navigation/event wiring and the user-visible drift repair states.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const settingsPanel = readFileSync(
  resolve("src/components/settings/SettingsPanel.tsx"),
  "utf-8",
);
const apiAccess = readFileSync(
  resolve("src/components/settings/ApiAccessSettings.tsx"),
  "utf-8",
);

describe("Settings API Access surface (#3520)", () => {
  it("is addressable through the existing settings section event", () => {
    expect(settingsPanel).toContain(
      '{ id: "api-access", label: "API Access"',
    );
    expect(settingsPanel).toContain(
      'activeSection() === "api-access"',
    );
    expect(settingsPanel).toContain("<ApiAccessSettings />");
    expect(settingsPanel).toContain('"seren:open-settings-section"');
  });

  it("surfaces detected scope drift and reconnects MCP after repair", () => {
    expect(apiAccess).toContain("Desktop automation access needs repair");
    expect(apiAccess).toContain("Current scopes");
    expect(apiAccess).toContain("Required by this build");
    expect(apiAccess).toContain("Repair / re-provision");
    expect(apiAccess).toContain("await resetGateway()");
    expect(apiAccess).toContain("await initializeGateway()");
  });
});
