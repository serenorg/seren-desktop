import { type Component, For, Show } from "solid-js";
import { closeTab, setActiveTab, type Tab, tabsState } from "@/stores/tabs";

interface FileTabsProps {
  onTabClose?: (tab: Tab) => boolean | undefined;
  isMarkdown?: boolean;
  showPreview?: boolean;
  onTogglePreview?: () => void;
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
    <div class="flex items-center h-9 bg-secondary border-b border-border">
      <div
        class="flex items-center flex-1 h-full overflow-hidden"
        role="tablist"
        aria-label="Open files"
      >
        <div class="flex items-center overflow-x-auto overflow-y-hidden flex-1 scrollbar-thin [&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-thumb]:rounded-sm">
          <For each={tabsState.tabs}>
            {(tab) => (
              <div
                class={`group flex items-center gap-1.5 h-full px-3 bg-secondary border-r border-border cursor-pointer text-[13px] whitespace-nowrap transition-colors hover:bg-muted ${tab.id === tabsState.activeTabId ? "bg-card border-b-2 border-b-primary" : ""} ${tab.isDirty ? "[&_.tab-name]:italic" : ""} focus:outline-none focus:shadow-[inset_0_0_0_1px_var(--primary)]`}
                onClick={() => handleTabClick(tab)}
                onMouseDown={(e) => handleMiddleClick(e, tab)}
                onKeyDown={(e) => handleKeyDown(e, tab)}
                role="tab"
                aria-selected={tab.id === tabsState.activeTabId}
                aria-controls={`panel-${tab.id}`}
                tabIndex={tab.id === tabsState.activeTabId ? 0 : -1}
                title={tab.filePath}
                data-testid="file-tab"
                data-file-path={tab.filePath}
              >
                <Show when={tab.isDirty}>
                  <span
                    class="text-warning text-[10px] -mr-0.5"
                    aria-label="Unsaved changes"
                  >
                    ●
                  </span>
                </Show>
                <span class="text-foreground max-w-[150px] overflow-hidden text-ellipsis whitespace-nowrap">
                  {tab.fileName}
                </span>
                <button
                  type="button"
                  class={`flex items-center justify-center w-4 h-4 border-none bg-transparent text-muted-foreground text-base leading-none cursor-pointer rounded-sm transition-all ${tab.isDirty ? "opacity-0 group-hover:opacity-100" : "opacity-0 group-hover:opacity-100"} hover:bg-muted hover:text-foreground`}
                  onClick={(e) => handleTabClose(e, tab)}
                  aria-label={`Close ${tab.fileName}`}
                  tabIndex={-1}
                  data-testid="file-tab-close"
                >
                  ×
                </button>
              </div>
            )}
          </For>
        </div>
        <Show when={tabsState.tabs.length === 0}>
          <div class="px-4 text-muted-foreground text-xs italic">
            No files open
          </div>
        </Show>
      </div>
      <Show when={props.isMarkdown}>
        <button
          type="button"
          class={`flex items-center justify-center w-9 h-9 bg-transparent border-none border-l border-border text-muted-foreground text-base cursor-pointer transition-all hover:bg-muted hover:text-foreground ${props.showPreview ? "bg-primary text-white" : ""}`}
          onClick={props.onTogglePreview}
          title={props.showPreview ? "Hide Preview" : "Show Preview"}
          aria-pressed={props.showPreview ? "true" : "false"}
        >
          👁
        </button>
      </Show>
    </div>
  );
};

export default FileTabs;
