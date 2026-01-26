// ABOUTME: Searchable dropdown for selecting AI models from OpenRouter.
// ABOUTME: Fetches full model list and allows filtering by name/provider.

import {
  type Component,
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { type Model, modelsService } from "@/services/models";
import "./SearchableModelSelect.css";

interface SearchableModelSelectProps {
  value: string;
  onChange: (modelId: string) => void;
  placeholder?: string;
}

export const SearchableModelSelect: Component<SearchableModelSelectProps> = (
  props,
) => {
  const [isOpen, setIsOpen] = createSignal(false);
  const [search, setSearch] = createSignal("");
  const [models, setModels] = createSignal<Model[]>([]);
  const [isLoading, setIsLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  let containerRef: HTMLDivElement | undefined;
  let inputRef: HTMLInputElement | undefined;

  // Load models on mount
  createEffect(() => {
    loadModels();
  });

  async function loadModels() {
    setIsLoading(true);
    setLoadError(null);
    try {
      const fetched = await modelsService.getAvailable();
      setModels(fetched);
      if (fetched.length === 0) {
        setLoadError("No models available");
      }
    } catch (err) {
      setLoadError("Failed to load models");
      console.error("Error loading models:", err);
    } finally {
      setIsLoading(false);
    }
  }

  // Filter models based on search
  const filteredModels = () => {
    const query = search().toLowerCase();
    if (!query) return models();
    return models().filter(
      (m) =>
        m.name.toLowerCase().includes(query) ||
        m.id.toLowerCase().includes(query) ||
        m.provider.toLowerCase().includes(query),
    );
  };

  // Get display name for current value
  const selectedModelName = () => {
    const model = models().find((m) => m.id === props.value);
    return model?.name || props.value || props.placeholder || "Select a model";
  };

  // Handle click outside to close
  const handleClickOutside = (e: MouseEvent) => {
    if (containerRef && !containerRef.contains(e.target as Node)) {
      setIsOpen(false);
    }
  };

  createEffect(() => {
    if (isOpen()) {
      document.addEventListener("click", handleClickOutside);
      // Focus search input when opened
      setTimeout(() => inputRef?.focus(), 0);
    } else {
      document.removeEventListener("click", handleClickOutside);
      setSearch("");
    }
  });

  onCleanup(() => {
    document.removeEventListener("click", handleClickOutside);
  });

  const handleSelect = (modelId: string) => {
    props.onChange(modelId);
    setIsOpen(false);
    setSearch("");
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setIsOpen(false);
    } else if (e.key === "Enter") {
      const filtered = filteredModels();
      if (filtered.length > 0) {
        handleSelect(filtered[0].id);
      }
    }
  };

  return (
    <div class="searchable-model-select" ref={containerRef}>
      <button
        type="button"
        class={`select-trigger ${isOpen() ? "open" : ""}`}
        onClick={() => setIsOpen(!isOpen())}
      >
        <span class="select-value">{selectedModelName()}</span>
        <span class="select-arrow">{isOpen() ? "▲" : "▼"}</span>
      </button>

      <Show when={isOpen()}>
        <div class="select-dropdown">
          <div class="select-search">
            <input
              ref={inputRef}
              type="text"
              placeholder="Search models..."
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
            />
            <Show when={!isLoading() && models().length > 0}>
              <span class="select-count">
                {filteredModels().length} of {models().length}
              </span>
            </Show>
          </div>

          <div class="select-options">
            <Show when={isLoading()}>
              <div class="select-loading">
                Loading models from OpenRouter...
              </div>
            </Show>

            <Show when={!isLoading() && loadError()}>
              <div class="select-error">
                {loadError()}
                <button type="button" onClick={loadModels}>
                  Retry
                </button>
              </div>
            </Show>

            <Show
              when={
                !isLoading() && !loadError() && filteredModels().length === 0
              }
            >
              <div class="select-empty">No models match "{search()}"</div>
            </Show>

            <For each={filteredModels()}>
              {(model) => (
                <button
                  type="button"
                  class={`select-option ${model.id === props.value ? "selected" : ""}`}
                  onClick={() => handleSelect(model.id)}
                >
                  <span class="option-name">{model.name}</span>
                  <span class="option-provider">{model.provider}</span>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default SearchableModelSelect;
