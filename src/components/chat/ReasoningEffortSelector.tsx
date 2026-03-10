// ABOUTME: Reasoning effort selector dropdown for models that support extended thinking.
// ABOUTME: Allows users to choose reasoning depth per conversation (minimal to xhigh).

import type { Component } from "solid-js";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { chatStore } from "@/stores/chat.store";

interface EffortOption {
  id: string;
  name: string;
  description: string;
}

const EFFORT_OPTIONS: EffortOption[] = [
  { id: "minimal", name: "Minimal", description: "Fastest, least reasoning" },
  { id: "low", name: "Low", description: "Quick with light reasoning" },
  { id: "medium", name: "Medium", description: "Balanced speed and depth" },
  { id: "high", name: "High", description: "Thorough reasoning" },
  { id: "xhigh", name: "Max", description: "Maximum depth, slowest" },
];

export const ReasoningEffortSelector: Component = () => {
  const [isOpen, setIsOpen] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;

  const activeEffort = () =>
    EFFORT_OPTIONS.find((o) => o.id === chatStore.reasoningEffort) ?? null;

  const handleSelect = (id: string | undefined) => {
    chatStore.setReasoningEffort(id);
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

  return (
    <div class="relative" ref={containerRef}>
      <button
        class="flex items-center gap-2 px-3 py-1.5 bg-popover border border-muted rounded-md text-sm text-foreground cursor-pointer transition-colors hover:border-muted-foreground/40"
        onClick={() => setIsOpen(!isOpen())}
        title="Set reasoning effort level for extended thinking models"
      >
        <span class="text-[14px]">🧠</span>
        <span class="text-foreground max-w-[120px] overflow-hidden text-ellipsis whitespace-nowrap">
          {activeEffort()?.name || "Auto"}
        </span>
        <span class="text-[10px] text-muted-foreground">
          {isOpen() ? "▲" : "▼"}
        </span>
      </button>

      <Show when={isOpen()}>
        <div class="absolute bottom-[calc(100%+8px)] left-0 min-w-[220px] bg-surface-2 border border-surface-3 rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.5)] z-[1000] overflow-hidden">
          {/* Header */}
          <div class="px-3 py-2 bg-surface-3 border-b border-surface-3">
            <span class="text-xs text-muted-foreground">Reasoning Effort</span>
          </div>

          {/* Options */}
          <div class="max-h-[250px] overflow-y-auto py-1 bg-surface-2">
            {/* Auto (default) option */}
            <button
              type="button"
              class={`w-full flex items-center justify-between gap-2 px-3 py-2 bg-transparent border-none text-left text-[13px] cursor-pointer transition-colors hover:bg-border ${!activeEffort() ? "bg-primary/[0.12]" : ""}`}
              onClick={() => handleSelect(undefined)}
            >
              <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                <span class="text-foreground font-medium">Auto</span>
                <span class="text-[11px] text-muted-foreground">
                  Provider decides reasoning depth
                </span>
              </div>
              <Show when={!activeEffort()}>
                <span class="text-success text-sm font-semibold">&#10003;</span>
              </Show>
            </button>

            {/* Effort level options */}
            <For each={EFFORT_OPTIONS}>
              {(option) => (
                <button
                  type="button"
                  class={`w-full flex items-center justify-between gap-2 px-3 py-2 bg-transparent border-none text-left text-[13px] cursor-pointer transition-colors hover:bg-border ${activeEffort()?.id === option.id ? "bg-primary/[0.12]" : ""}`}
                  onClick={() => handleSelect(option.id)}
                >
                  <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                    <span class="text-foreground font-medium">
                      {option.name}
                    </span>
                    <span class="text-[11px] text-muted-foreground">
                      {option.description}
                    </span>
                  </div>
                  <Show when={activeEffort()?.id === option.id}>
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

export default ReasoningEffortSelector;
