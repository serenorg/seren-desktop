// ABOUTME: Publisher suggestion component that displays relevant publishers based on chat input.
// ABOUTME: Shows clickable suggestions with name, description, and pricing info.

import { type Component, For, Show } from "solid-js";
import { getPricingDisplay, type Publisher } from "@/services/catalog";

interface PublisherSuggestionsProps {
  suggestions: Publisher[];
  isLoading: boolean;
  onSelect: (publisher: Publisher) => void;
  onDismiss: () => void;
}

export const PublisherSuggestions: Component<PublisherSuggestionsProps> = (
  props,
) => {
  return (
    <Show when={props.suggestions.length > 0 || props.isLoading}>
      <div class="absolute bottom-full left-0 right-0 mb-2 bg-[#1e1e1e] border border-border rounded-lg shadow-[0_4px_12px_rgba(0,0,0,0.3)] overflow-hidden z-[100]">
        <div class="flex items-center justify-between px-3 py-2 border-b border-border bg-popover">
          <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            {props.isLoading ? "Finding relevant tools..." : "Suggested tools"}
          </span>
          <button
            class="flex items-center justify-center w-5 h-5 p-0 border-none rounded bg-transparent text-muted-foreground text-base cursor-pointer transition-all hover:bg-[rgba(255,255,255,0.1)] hover:text-foreground"
            onClick={() => props.onDismiss()}
            title="Dismiss suggestions"
            aria-label="Dismiss suggestions"
          >
            ×
          </button>
        </div>
        <Show
          when={!props.isLoading}
          fallback={
            <div class="flex items-center justify-center p-4">
              <span class="w-5 h-5 border-2 border-border border-t-primary rounded-full animate-[spin_0.8s_linear_infinite]" />
            </div>
          }
        >
          <ul class="list-none m-0 p-1 max-h-[200px] overflow-y-auto">
            <For each={props.suggestions}>
              {(publisher) => (
                <li>
                  <button
                    class="flex items-center gap-3 w-full px-2 py-2 border-none rounded-md bg-transparent text-left cursor-pointer transition-colors hover:bg-[rgba(255,255,255,0.05)] focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-[-2px]"
                    onClick={() => props.onSelect(publisher)}
                  >
                    <Show
                      when={publisher.logo_url}
                      fallback={
                        <div class="w-8 h-8 rounded-md flex items-center justify-center bg-popover text-muted-foreground font-semibold text-sm shrink-0">
                          {publisher.name.charAt(0).toUpperCase()}
                        </div>
                      }
                    >
                      {(logoUrl) => (
                        <img
                          src={logoUrl()}
                          alt={`${publisher.name} logo`}
                          class="w-8 h-8 rounded-md object-cover shrink-0"
                        />
                      )}
                    </Show>
                    <div class="flex-1 min-w-0 flex flex-col gap-0.5">
                      <span class="flex items-center gap-1 text-sm font-medium text-foreground">
                        {publisher.name}
                        <Show when={publisher.is_verified}>
                          <span
                            class="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-success text-black text-[10px] font-bold"
                            title="Verified"
                          >
                            ✓
                          </span>
                        </Show>
                      </span>
                      <span class="text-xs text-muted-foreground whitespace-nowrap overflow-hidden text-ellipsis">
                        {publisher.description}
                      </span>
                    </div>
                    <span class="shrink-0 px-2 py-1 rounded bg-popover text-[11px] font-medium text-muted-foreground">
                      {getPricingDisplay(publisher)}
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </Show>
  );
};
