// ABOUTME: Static UI contract tests for the issue #1823 Keys settings panel.
// ABOUTME: Keeps mockup-critical copy and navigation wired without broad DOM tests.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const settingsPanel = readFileSync(
  resolve("src/components/settings/SettingsPanel.tsx"),
  "utf-8",
);
const keysSettings = readFileSync(
  resolve("src/components/settings/KeysSettings.tsx"),
  "utf-8",
);

describe("Settings navigation includes Keys (#1823)", () => {
  it("adds a dedicated Keys section between Logins and Toolsets", () => {
    const logins = settingsPanel.indexOf('{ id: "logins"');
    const keys = settingsPanel.indexOf('{ id: "keys"');
    const toolsets = settingsPanel.indexOf('{ id: "toolsets"');

    expect(logins).toBeGreaterThan(-1);
    expect(keys).toBeGreaterThan(logins);
    expect(toolsets).toBeGreaterThan(keys);
    expect(settingsPanel).toContain("<KeysSettings />");
  });
});

describe("KeysSettings mockup contract (#1823)", () => {
  it("states the per-skill and python-dotenv migration model", () => {
    expect(keysSettings).toContain("1 per skill");
    expect(keysSettings).toContain("python-dotenv shim");
    expect(keysSettings).toContain("Review & migrate");
  });

  it("requires service + skill on add key and documents replacement warning", () => {
    expect(keysSettings).toContain("required · 1:1 binding");
    expect(keysSettings).toContain("already has a");
    expect(keysSettings).toContain("will replace it");
  });

  it("surfaces always-ask and session approval defaults", () => {
    expect(keysSettings).toContain("$0.00 · always ask");
    expect(keysSettings).toContain("Session approval defaults");
    expect(keysSettings).toContain("30 minutes");
    expect(keysSettings).toContain("$200.00");
  });

  it("renders approval and activity session language from the v4 mocks", () => {
    expect(keysSettings).toContain("Approve & start 30 min session");
    expect(keysSettings).toContain("Session-approved");
    expect(keysSettings).toContain("ACTIVE SESSION");
    expect(keysSettings).toContain("End now");
  });
});
