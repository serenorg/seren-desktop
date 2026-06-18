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

describe("KeysSettings Seren Passwords contract (#1823)", () => {
  it("states the per-skill reference and migration model", () => {
    expect(keysSettings).toContain("Unlock your vault");
    expect(keysSettings).toContain(".env migration");
    expect(keysSettings).toContain("Review migration");
  });

  it("requires service + skill on add reference and documents replacement warning", () => {
    expect(keysSettings).toContain("required · 1:1 binding");
    expect(keysSettings).toContain("already has");
    expect(keysSettings).toContain("Saving replaces");
  });

  it("prompts to unlock or create a vault before editing entries", () => {
    expect(keysSettings).toContain("Unlock Seren Passwords");
    expect(keysSettings).toContain("Create your vault");
    expect(keysSettings).toContain("Save your recovery key");
    expect(keysSettings).toContain("New vault entry");
    expect(keysSettings).toContain("Edit vault entry");
    expect(keysSettings).toContain("Use for binding");
  });

  it("requires acknowledging the recovery key and states local-only derivation", () => {
    expect(keysSettings).toContain("I have saved it");
    expect(keysSettings).toContain("it will not be shown");
    expect(keysSettings).toContain("derived locally; Seren");
  });

  it("offers a friendly grant-access flow with an advanced escape", () => {
    expect(keysSettings).toContain("Give an agent access");
    expect(keysSettings).toContain("Grant access");
    expect(keysSettings).toContain("Update access");
    expect(keysSettings).toContain("can request ");
    // Advanced mode still exposes the raw editor.
    expect(keysSettings).toContain("Advanced");
  });

  it("surfaces always-ask and session approval defaults", () => {
    expect(keysSettings).toContain("$0.00 · always ask");
    expect(keysSettings).toContain("Session approval defaults");
    expect(keysSettings).toContain("30 minutes");
    expect(keysSettings).toContain("$200.00");
  });

  it("renders activity session language", () => {
    expect(keysSettings).toContain("Session-approved");
    expect(keysSettings).toContain("ACTIVE SESSION");
    expect(keysSettings).toContain("End now");
  });

  it("guards stale vault list and item-detail responses", () => {
    expect(keysSettings).toContain("vaultItemsRequestId");
    expect(keysSettings).toContain("vaultItemDetailRequestId");
    expect(keysSettings).toContain("selectedVaultId() !== vaultId");
    expect(keysSettings).toContain("selectedVaultId() !== item.vaultId");
  });
});
