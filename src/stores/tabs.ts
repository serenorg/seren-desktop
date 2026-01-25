import { createStore } from "solid-js/store";

export interface Tab {
  id: string;
  filePath: string;
  fileName: string;
  isDirty: boolean;
  content: string;
}

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
}

const [tabsState, setTabsState] = createStore<TabsState>({
  tabs: [],
  activeTabId: null,
});

/**
 * Open a file in a new tab or focus existing tab.
 */
export function openTab(filePath: string, content: string = ""): string {
  const existing = tabsState.tabs.find((t) => t.filePath === filePath);
  if (existing) {
    setTabsState("activeTabId", existing.id);
    return existing.id;
  }

  const id = crypto.randomUUID();
  const fileName = filePath.split("/").pop() || filePath;

  setTabsState("tabs", (tabs) => [
    ...tabs,
    { id, filePath, fileName, isDirty: false, content },
  ]);
  setTabsState("activeTabId", id);

  return id;
}

/**
 * Close a tab by ID.
 */
export function closeTab(tabId: string): void {
  const index = tabsState.tabs.findIndex((t) => t.id === tabId);
  if (index === -1) return;

  // If closing active tab, switch to adjacent tab
  if (tabsState.activeTabId === tabId) {
    const newActiveIndex =
      index > 0 ? index - 1 : tabsState.tabs.length > 1 ? 1 : null;
    setTabsState(
      "activeTabId",
      newActiveIndex !== null ? tabsState.tabs[newActiveIndex].id : null
    );
  }

  setTabsState("tabs", (tabs) => tabs.filter((t) => t.id !== tabId));
}

/**
 * Close all tabs.
 */
export function closeAllTabs(): void {
  setTabsState("tabs", []);
  setTabsState("activeTabId", null);
}

/**
 * Set the active tab.
 */
export function setActiveTab(tabId: string): void {
  if (tabsState.tabs.some((t) => t.id === tabId)) {
    setTabsState("activeTabId", tabId);
  }
}

/**
 * Update tab content.
 */
export function updateTabContent(tabId: string, content: string): void {
  setTabsState(
    "tabs",
    (t) => t.id === tabId,
    "content",
    content
  );
}

/**
 * Set tab dirty state.
 */
export function setTabDirty(tabId: string, isDirty: boolean): void {
  setTabsState(
    "tabs",
    (t) => t.id === tabId,
    "isDirty",
    isDirty
  );
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
