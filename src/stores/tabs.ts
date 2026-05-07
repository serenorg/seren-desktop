// ABOUTME: Editor tab state. Tabs carry a cwd that groups them into editor sessions.
// ABOUTME: Active tab is tracked per cwd so switching sessions restores the last active tab.

import { createStore } from "solid-js/store";

export interface Tab {
  id: string;
  filePath: string;
  fileName: string;
  /** Canonical session root (skill dir, project root, or file dirname). */
  cwd: string;
  isDirty: boolean;
  content: string;
}

interface TabsState {
  tabs: Tab[];
  /** Currently focused tab id. Always belongs to a session whose cwd matches. */
  activeTabId: string | null;
  /** Per-session memory of the last active tab so switching sessions restores it. */
  lastActiveByCwd: Record<string, string>;
  /** Per-session activation epoch. Drives sidebar recency sort and bubble-to-top. */
  lastActiveAtByCwd: Record<string, number>;
}

const [tabsState, setTabsState] = createStore<TabsState>({
  tabs: [],
  activeTabId: null,
  lastActiveByCwd: {},
  lastActiveAtByCwd: {},
});

function bumpSessionActivity(cwd: string): void {
  setTabsState("lastActiveAtByCwd", cwd, Date.now());
}

function rememberActive(tabId: string): void {
  const tab = tabsState.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  setTabsState("lastActiveByCwd", tab.cwd, tabId);
  bumpSessionActivity(tab.cwd);
}

/**
 * Open a file in a new tab or focus the existing tab. The caller supplies the
 * cwd (skill dir for skills, project root for project files, file dirname as a
 * fallback) so the tab joins the correct editor session.
 */
export function openTab(
  filePath: string,
  content: string,
  cwd: string,
): string {
  const existing = tabsState.tabs.find((t) => t.filePath === filePath);
  if (existing) {
    setTabsState("activeTabId", existing.id);
    rememberActive(existing.id);
    return existing.id;
  }

  const id = crypto.randomUUID();
  const fileName = filePath.split("/").pop() || filePath;

  setTabsState("tabs", (tabs) => [
    ...tabs,
    { id, filePath, fileName, cwd, isDirty: false, content },
  ]);
  setTabsState("activeTabId", id);
  setTabsState("lastActiveByCwd", cwd, id);
  bumpSessionActivity(cwd);
  return id;
}

/**
 * Close a tab by ID. Focus shifts to the previous tab in the same session
 * when the closed tab was active; if no tab in this session remains, focus
 * falls back to any other tab so the editor pane is never empty when work
 * exists in another session.
 */
export function closeTab(tabId: string): void {
  const index = tabsState.tabs.findIndex((t) => t.id === tabId);
  if (index === -1) return;
  const closed = tabsState.tabs[index];

  if (tabsState.activeTabId === tabId) {
    const sameSession = tabsState.tabs.filter(
      (t) => t.cwd === closed.cwd && t.id !== tabId,
    );
    const fallback =
      sameSession[Math.min(sameSession.length - 1, 0)] ??
      tabsState.tabs.find((t) => t.id !== tabId);
    setTabsState("activeTabId", fallback?.id ?? null);
    if (fallback) rememberActive(fallback.id);
  }

  setTabsState("tabs", (tabs) => tabs.filter((t) => t.id !== tabId));
  setTabsState("lastActiveByCwd", (memory) => {
    if (memory[closed.cwd] !== tabId) return memory;
    const next = { ...memory };
    delete next[closed.cwd];
    return next;
  });
}

/**
 * Close all tabs.
 */
export function closeAllTabs(): void {
  setTabsState("tabs", []);
  setTabsState("activeTabId", null);
  setTabsState("lastActiveByCwd", {});
}

/**
 * Set the active tab. Updates per-session memory so switching to another
 * session and back restores this tab.
 */
export function setActiveTab(tabId: string): void {
  if (tabsState.tabs.some((t) => t.id === tabId)) {
    setTabsState("activeTabId", tabId);
    rememberActive(tabId);
  }
}

/**
 * Replay the per-session "last active tab" memory for a single cwd. Used by
 * the persistence layer to restore the user's per-session focus on app
 * boot without changing which session is currently visible.
 */
export function rememberSessionActiveTab(cwd: string, tabId: string): void {
  if (tabsState.tabs.some((t) => t.id === tabId)) {
    setTabsState("lastActiveByCwd", cwd, tabId);
  }
}

/**
 * Restore a per-cwd activation epoch (used by the persistence layer). Does
 * not change which session is currently visible.
 */
export function restoreSessionActiveAt(cwd: string, ts: number): void {
  setTabsState("lastActiveAtByCwd", cwd, ts);
}

/** Bump a session's activation epoch so it floats to the top of the sidebar. */
export function bumpSessionActiveAt(cwd: string): void {
  bumpSessionActivity(cwd);
}

/**
 * Activate the most recent tab from `cwd`. Used when switching sessions:
 * the editor pane refocuses the tab the user was last looking at.
 */
export function setActiveSessionByCwd(cwd: string): void {
  const remembered = tabsState.lastActiveByCwd[cwd];
  if (remembered && tabsState.tabs.some((t) => t.id === remembered)) {
    setTabsState("activeTabId", remembered);
    return;
  }
  const fallback = tabsState.tabs.find((t) => t.cwd === cwd);
  if (fallback) {
    setTabsState("activeTabId", fallback.id);
    setTabsState("lastActiveByCwd", cwd, fallback.id);
  }
}

/**
 * Update tab content.
 */
export function updateTabContent(tabId: string, content: string): void {
  setTabsState("tabs", (t) => t.id === tabId, "content", content);
}

/**
 * Set tab dirty state.
 */
export function setTabDirty(tabId: string, isDirty: boolean): void {
  setTabsState("tabs", (t) => t.id === tabId, "isDirty", isDirty);
}

/**
 * Get the active tab.
 */
export function getActiveTab(): Tab | undefined {
  return tabsState.tabs.find((t) => t.id === tabsState.activeTabId);
}

/**
 * Get tab by file path.
 */
export function getTabByPath(filePath: string): Tab | undefined {
  return tabsState.tabs.find((t) => t.filePath === filePath);
}

/**
 * Check if there are unsaved changes.
 */
export function hasUnsavedChanges(): boolean {
  return tabsState.tabs.some((t) => t.isDirty);
}

/**
 * Get all dirty tabs.
 */
export function getDirtyTabs(): Tab[] {
  return tabsState.tabs.filter((t) => t.isDirty);
}

export { tabsState };
