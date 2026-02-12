// ABOUTME: Collapsible thinking/reasoning block for AI responses.
// ABOUTME: Shows the AI's chain of thought when enabled in settings.

import type { Component } from "solid-js";
import { createEffect, createSignal, Show } from "solid-js";
import { settingsStore } from "@/stores/settings.store";

interface ThinkingBlockProps {
  thinking: string;
  isStreaming?: boolean;
}

export const ThinkingBlock: Component<ThinkingBlockProps> = (props) => {
  const initialPreference = settingsStore.get("chatThinkingExpanded");
  const [isExpanded, setIsExpanded] = createSignal(
    props.isStreaming ? true : initialPreference,
  );
  let lastStoredPreference = initialPreference;

  createEffect(() => {
    const storedPreference = settingsStore.get("chatThinkingExpanded");
    if (storedPreference !== lastStoredPreference) {
      lastStoredPreference = storedPreference;
      setIsExpanded(storedPreference);
    }
  });

  const handleToggle = () => {
    const next = !isExpanded();
    setIsExpanded(next);
    settingsStore.set("chatThinkingExpanded", next);
  };

  return (
    <div class="mb-3 border border-surface-3 rounded-lg overflow-hidden bg-surface-0">
      <button
        type="button"
        class="w-full flex items-center gap-2 px-3 py-2 bg-surface-2 text-muted-foreground text-xs font-medium cursor-pointer hover:bg-surface-3 transition-colors border-none text-left"
        onClick={handleToggle}
      >
        <svg
          class={`w-3 h-3 transition-transform ${isExpanded() ? "rotate-90" : ""}`}
          fill="currentColor"
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
        </svg>
        <span>Thinking</span>
        <Show when={props.isStreaming}>
          <span class="inline-block w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
        </Show>
      </button>
      <Show when={isExpanded()}>
        <div class="px-3 py-2 text-xs text-foreground/70 leading-relaxed whitespace-pre-wrap max-h-[300px] overflow-y-auto">
          {props.thinking}
          <Show when={props.isStreaming}>
            <span class="inline-block w-0.5 h-[1em] bg-primary ml-0.5 align-text-bottom animate-[blink_1s_step-end_infinite]" />
          </Show>
        </div>
      </Show>
    </div>
  );
};
