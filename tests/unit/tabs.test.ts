// ABOUTME: Unit tests for editor tab state.
// ABOUTME: Covers saved-content baselines used by Monaco dirty tracking.

import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

describe("tabs store", () => {
  it("keeps saved content separate from live dirty content", async () => {
    const {
      openTab,
      setTabDirty,
      setTabSavedContent,
      tabsState,
      updateTabContent,
    } = await import("@/stores/tabs");

    const tabId = openTab("/skill/SKILL.md", "saved", "/skill");

    updateTabContent(tabId, "draft");
    setTabDirty(tabId, true);

    const draft = tabsState.tabs.find((tab) => tab.id === tabId);
    expect(draft?.content).toBe("draft");
    expect(draft?.savedContent).toBe("saved");
    expect(draft?.isDirty).toBe(true);

    setTabSavedContent(tabId, "draft");
    setTabDirty(tabId, false);

    const saved = tabsState.tabs.find((tab) => tab.id === tabId);
    expect(saved?.content).toBe("draft");
    expect(saved?.savedContent).toBe("draft");
    expect(saved?.isDirty).toBe(false);
  });
});
