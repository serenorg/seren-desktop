import { For, Show, type Component } from "solid-js";
import {
  tabsState,
  setActiveTab,
  closeTab,
  type Tab,
} from "@/stores/tabs";
import "./FileTabs.css";

interface FileTabsProps {
  onTabClose?: (tab: Tab) => boolean | void;
}

export const FileTabs: Component<FileTabsProps> = (props) => {
  function handleTabClick(tab: Tab) {
    setActiveTab(tab.id);
  }

  function handleTabClose(e: MouseEvent, tab: Tab) {
    e.stopPropagation();

    // Allow parent to prevent close (e.g., for unsaved changes prompt)
    const shouldClose = props.onTabClose?.(tab);
    if (shouldClose === false) return;

    closeTab(tab.id);
  }

  function handleMiddleClick(e: MouseEvent, tab: Tab) {
    if (e.button === 1) {
      e.preventDefault();
      handleTabClose(e, tab);
    }
  }

  function handleKeyDown(e: KeyboardEvent, tab: Tab) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setActiveTab(tab.id);
    }
  }

  return (
    <div class="file-tabs" role="tablist" aria-label="Open files">
      <div class="file-tabs-scroll">
        <For each={tabsState.tabs}>
          {(tab) => (
            <div
              class="file-tab"
              classList={{
                active: tab.id === tabsState.activeTabId,
                dirty: tab.isDirty,
              }}
              onClick={() => handleTabClick(tab)}
              onMouseDown={(e) => handleMiddleClick(e, tab)}
              onKeyDown={(e) => handleKeyDown(e, tab)}
              role="tab"
              aria-selected={tab.id === tabsState.activeTabId}
              aria-controls={`panel-${tab.id}`}
              tabIndex={tab.id === tabsState.activeTabId ? 0 : -1}
              title={tab.filePath}
            >
              <Show when={tab.isDirty}>
                <span class="file-tab-dirty-indicator" aria-label="Unsaved changes">●</span>
              </Show>
              <span class="file-tab-name">{tab.fileName}</span>
              <button
                class="file-tab-close"
                onClick={(e) => handleTabClose(e, tab)}
                aria-label={`Close ${tab.fileName}`}
                tabIndex={-1}
              >
                ×
              </button>
            </div>
          )}
        </For>
      </div>
      <Show when={tabsState.tabs.length === 0}>
        <div class="file-tabs-empty">No files open</div>
      </Show>
    </div>
  );
};

export default FileTabs;
