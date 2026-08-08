// ABOUTME: Per-thread Seren Models routing preference selector (Fastest/Cheapest).
// ABOUTME: Persists the choice on the conversation row; requests map it to provider.sort.

import type { Component } from "solid-js";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  DEFAULT_ROUTING_PREFERENCE,
  ROUTING_PREFERENCE_OPTIONS,
  type RoutingPreference,
} from "@/lib/providers/routing-preference";
import { conversationStore } from "@/stores/conversation.store";

interface RoutingPreferenceSelectorProps {
  threadId: string | null;
}

export const RoutingPreferenceSelector: Component<
  RoutingPreferenceSelectorProps
> = (props) => {
  const [isOpen, setIsOpen] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;

  // Legacy threads (null) behave as Fastest — the server default.
  const activePreference = (): RoutingPreference =>
    conversationStore.getRoutingPreference(props.threadId) ??
    DEFAULT_ROUTING_PREFERENCE;

  const activeOption = () =>
    ROUTING_PREFERENCE_OPTIONS.find((o) => o.id === activePreference()) ??
    ROUTING_PREFERENCE_OPTIONS[0];

  const handleSelect = (id: RoutingPreference) => {
    setIsOpen(false);
    if (props.threadId) {
      void conversationStore.updateConversationRoutingPreference(
        props.threadId,
        id,
      );
    }
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
        type="button"
        class="flex items-center gap-2 px-3 py-1.5 bg-popover border border-muted rounded-md text-sm text-foreground cursor-pointer transition-colors hover:border-muted-foreground/40"
        onClick={() => setIsOpen(!isOpen())}
        title="Choose how Seren Models routes this thread's requests"
      >
        <span class="text-[14px]">🧭</span>
        <span class="text-foreground max-w-[120px] overflow-hidden text-ellipsis whitespace-nowrap">
          {activeOption().name}
        </span>
        <span class="text-[10px] text-muted-foreground">
          {isOpen() ? "▲" : "▼"}
        </span>
      </button>

      <Show when={isOpen()}>
        <div class="absolute bottom-[calc(100%+8px)] left-0 min-w-[240px] bg-surface-2 border border-surface-3 rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.5)] z-[1000] overflow-hidden">
          <div class="px-3 py-2 bg-surface-3 border-b border-surface-3">
            <span class="text-xs text-muted-foreground">Routing</span>
          </div>

          <div class="max-h-[250px] overflow-y-auto py-1 bg-surface-2">
            <For each={ROUTING_PREFERENCE_OPTIONS}>
              {(option) => (
                <button
                  type="button"
                  class={`w-full flex items-center justify-between gap-2 px-3 py-2 bg-transparent border-none text-left text-[13px] cursor-pointer transition-colors hover:bg-border ${activePreference() === option.id ? "bg-primary/[0.12]" : ""}`}
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
                  <Show when={activePreference() === option.id}>
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

export default RoutingPreferenceSelector;
