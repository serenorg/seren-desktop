// ABOUTME: Static UI contract tests for the Appearance settings panel.
// ABOUTME: Keeps theme controls, labels, and previews accessible as markup evolves.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const settingsPanel = readFileSync(
  resolve("src/components/settings/SettingsPanel.tsx"),
  "utf-8",
);

describe("Appearance settings UI", () => {
  it("uses radiogroup semantics and roving keyboard handling for theme choices", () => {
    expect(settingsPanel).toContain('id="appearance-theme-label"');
    expect(settingsPanel).toContain('aria-labelledby="appearance-theme-label"');
    expect(settingsPanel).toContain('role="radiogroup"');
    expect(settingsPanel).toContain('role="radio"');
    expect(settingsPanel).toContain('["dark", "light", "system"] as const');
    expect(settingsPanel).toContain("handleRadioGroupKeydown");
  });

  it("does not point labels at non-labelable appearance control containers", () => {
    expect(settingsPanel).not.toContain('for="appearance-density"');
    expect(settingsPanel).not.toContain('for="appearance-chat-font-size"');
    expect(settingsPanel).not.toContain(
      'for="appearance-thread-list-font-size"',
    );
    expect(settingsPanel).not.toContain('for="appearance-terminal-font-size"');
  });

  it("keeps preview labels aligned with the controls they demonstrate", () => {
    expect(settingsPanel).toContain('id="appearance-preview-label"');
    expect(settingsPanel).toContain("Conversation");
    expect(settingsPanel).toContain("Thread list");
    expect(settingsPanel).toContain("Terminal");
  });
});
