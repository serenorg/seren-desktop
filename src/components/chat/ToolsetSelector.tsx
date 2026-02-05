// ABOUTME: Toolset selector dropdown for scoping which publishers the agent can use.
// ABOUTME: Shows "All Publishers" or a specific toolset to filter available tools.

import type { Component } from "solid-js";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  settingsState,
  setActiveToolset,
  getActiveToolset,
} from "@/stores/settings.store";

export const ToolsetSelector: Component = () => {
  const [isOpen, setIsOpen] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;

  const toolsets = () => settingsState.toolsets.toolsets;
  const activeToolset = () => getActiveToolset();

  const handleSelect = async (id: string | null) => {
    await setActiveToolset(id);
    setIsOpen(false);
  };

  const handleDocumentClick = (event: MouseEvent) => {
    if (!isOpen()) return;
    if (
      containerRef &&
      event.target instanceof Node &&
      !containerRef.contains(event.target)
    ) {
      setIsOpen(false);
    }
  };

  onMount(() => {
    document.addEventListener("click", handleDocumentClick);
  });

  onCleanup(() => {
    document.removeEventListener("click", handleDocumentClick);
  });

  // Don't render if no toolsets exist
  if (toolsets().length === 0) {
    return null;
  }

  return (
    <div class="relative" ref={containerRef}>
      <button
        class="flex items-center gap-2 px-3 py-1.5 bg-popover border border-muted rounded-md text-sm text-foreground cursor-pointer transition-colors hover:border-[rgba(148,163,184,0.4)]"
        onClick={() => setIsOpen(!isOpen())}
        title={activeToolset()?.description || "Select a toolset to scope available tools"}
      >
        <span class="text-[14px]">📦</span>
        <span class="text-foreground max-w-[120px] overflow-hidden text-ellipsis whitespace-nowrap">
          {activeToolset()?.name || "All Publishers"}
        </span>
        <span class="text-[10px] text-muted-foreground">
          {isOpen() ? "▲" : "▼"}
        </span>
      </button>

      <Show when={isOpen()}>
        <div class="absolute bottom-[calc(100%+8px)] left-0 min-w-[220px] bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.5)] z-[1000] overflow-hidden">
          {/* Header */}
          <div class="px-3 py-2 bg-[#252525] border-b border-[#3c3c3c]">
            <span class="text-xs text-muted-foreground">Active Toolset</span>
          </div>

          {/* Options */}
          <div class="max-h-[250px] overflow-y-auto py-1 bg-[#1e1e1e]">
            {/* All Publishers option */}
            <button
              type="button"
              class={`w-full flex items-center justify-between gap-2 px-3 py-2 bg-transparent border-none text-left text-[13px] cursor-pointer transition-colors hover:bg-[rgba(148,163,184,0.1)] ${!activeToolset() ? "bg-[rgba(99,102,241,0.12)]" : ""}`}
              onClick={() => handleSelect(null)}
            >
              <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                <span class="text-foreground font-medium">All Publishers</span>
                <span class="text-[11px] text-muted-foreground">
                  No filtering - use any publisher
                </span>
              </div>
              <Show when={!activeToolset()}>
                <span class="text-success text-sm font-semibold">&#10003;</span>
              </Show>
            </button>

            {/* Toolset options */}
            <For each={toolsets()}>
              {(toolset) => (
                <button
                  type="button"
                  class={`w-full flex items-center justify-between gap-2 px-3 py-2 bg-transparent border-none text-left text-[13px] cursor-pointer transition-colors hover:bg-[rgba(148,163,184,0.1)] ${activeToolset()?.id === toolset.id ? "bg-[rgba(99,102,241,0.12)]" : ""}`}
                  onClick={() => handleSelect(toolset.id)}
                >
                  <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                    <span class="text-foreground font-medium">
                      {toolset.name}
                    </span>
                    <span class="text-[11px] text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap">
                      {toolset.publisherSlugs.length} publisher
                      {toolset.publisherSlugs.length !== 1 ? "s" : ""}
                      {toolset.description ? ` • ${toolset.description}` : ""}
                    </span>
                  </div>
                  <Show when={activeToolset()?.id === toolset.id}>
                    <span class="text-success text-sm font-semibold">
                      &#10003;
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default ToolsetSelector;
