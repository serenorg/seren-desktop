// ABOUTME: Critical regression test for agent composer toolbar layout invariants.
// ABOUTME: Guards #1982 (Send/Cancel never clipped) and #2062 (Skills chip stays visible via wrap).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPOSER_TOOLBAR_LEFT_GROUP_CLASSES,
  COMPOSER_TOOLBAR_RIGHT_GROUP_CLASSES,
  COMPOSER_TOOLBAR_ROOT_CLASSES,
} from "@/components/chat/composerToolbarClasses";
import { FLOATING_SELECTOR_MENU_BASE_CLASSES } from "@/components/chat/floatingSelectorMenuClasses";

describe("composer toolbar layout invariants (#1982, #2062)", () => {
  it("right group must be pinned with shrink-0 so Cancel/Send is never clipped (#1982)", () => {
    expect(COMPOSER_TOOLBAR_RIGHT_GROUP_CLASSES).toMatch(/\bshrink-0\b/);
  });

  it("left group must shrink (min-w-0 + flex-1) before pushing the right group off-screen (#1982)", () => {
    expect(COMPOSER_TOOLBAR_LEFT_GROUP_CLASSES).toMatch(/\bmin-w-0\b/);
    expect(COMPOSER_TOOLBAR_LEFT_GROUP_CLASSES).toMatch(/\bflex-1\b/);
  });

  it("left group must wrap (not scroll) so overflowing chips like Skills stay visible when the docked Skills panel narrows the pane (#2062)", () => {
    expect(COMPOSER_TOOLBAR_LEFT_GROUP_CLASSES).toMatch(/\bflex-wrap\b/);
    // Horizontal scroll silently hid the last chip (Skills) off-screen; wrapping replaces it.
    expect(COMPOSER_TOOLBAR_LEFT_GROUP_CLASSES).not.toMatch(/\boverflow-x-auto\b/);
  });

  it("root toolbar must keep justify-between + gap and top-align the pinned group when the left group wraps (#2062)", () => {
    expect(COMPOSER_TOOLBAR_ROOT_CLASSES).toMatch(/\bjustify-between\b/);
    expect(COMPOSER_TOOLBAR_ROOT_CLASSES).toMatch(/\bgap-\d+\b/);
    expect(COMPOSER_TOOLBAR_ROOT_CLASSES).toMatch(/\bitems-start\b/);
  });

  it("agent selector menus must use fixed-positioned portals so they escape the toolbar regardless of wrap/overflow (#1992)", () => {
    expect(FLOATING_SELECTOR_MENU_BASE_CLASSES).toMatch(/\bfixed\b/);

    for (const file of [
      "src/components/chat/ThreadProviderSwitcher.tsx",
      "src/components/chat/AgentModelSelector.tsx",
      "src/components/chat/AgentModeSelector.tsx",
      "src/components/chat/AgentEffortSelector.tsx",
    ]) {
      const source = readFileSync(resolve(file), "utf-8");
      expect(source).toContain("FloatingSelectorMenu");
    }
  });
});
