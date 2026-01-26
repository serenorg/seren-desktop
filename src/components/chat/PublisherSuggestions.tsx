// ABOUTME: Publisher suggestion component that displays relevant publishers based on chat input.
// ABOUTME: Shows clickable suggestions with name, description, and pricing info.

import { type Component, For, Show } from "solid-js";
import { getPricingDisplay, type Publisher } from "@/services/catalog";
import "./PublisherSuggestions.css";

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
      <div class="publisher-suggestions">
        <div class="publisher-suggestions__header">
          <span class="publisher-suggestions__title">
            {props.isLoading ? "Finding relevant tools..." : "Suggested tools"}
          </span>
          <button
            class="publisher-suggestions__dismiss"
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
            <div class="publisher-suggestions__loading">
              <span class="publisher-suggestions__spinner" />
            </div>
          }
        >
          <ul class="publisher-suggestions__list">
            <For each={props.suggestions}>
              {(publisher) => (
                <li>
                  <button
                    class="publisher-suggestion"
                    onClick={() => props.onSelect(publisher)}
                  >
                    <Show
                      when={publisher.logo_url}
                      fallback={
                        <div class="publisher-suggestion__logo publisher-suggestion__logo--placeholder">
                          {publisher.name.charAt(0).toUpperCase()}
                        </div>
                      }
                    >
                      <img
                        src={publisher.logo_url!}
                        alt={`${publisher.name} logo`}
                        class="publisher-suggestion__logo"
                      />
                    </Show>
                    <div class="publisher-suggestion__info">
                      <span class="publisher-suggestion__name">
                        {publisher.name}
                        <Show when={publisher.is_verified}>
                          <span
                            class="publisher-suggestion__verified"
                            title="Verified"
                          >
                            ✓
                          </span>
                        </Show>
                      </span>
                      <span class="publisher-suggestion__description">
                        {publisher.description}
                      </span>
                    </div>
                    <span class="publisher-suggestion__price">
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
