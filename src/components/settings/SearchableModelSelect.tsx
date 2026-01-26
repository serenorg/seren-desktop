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
    <div class="relative w-full" ref={containerRef}>
      <button
        type="button"
        class={`w-full flex justify-between items-center px-3 py-2 bg-[#0d1117] border border-[#30363d] text-[#e6edf3] text-sm cursor-pointer transition-[border-color] duration-150 ${
          isOpen()
            ? "border-[#58a6ff] rounded-t-md rounded-b-none"
            : "rounded-md hover:border-[#484f58]"
        }`}
        onClick={() => setIsOpen(!isOpen())}
      >
        <span class="overflow-hidden text-ellipsis whitespace-nowrap">
          {selectedModelName()}
        </span>
        <span class="text-[10px] text-[#8b949e] ml-2">
          {isOpen() ? "▲" : "▼"}
        </span>
      </button>

      <Show when={isOpen()}>
        <div class="absolute top-full left-0 right-0 bg-[#161b22] border border-[#58a6ff] border-t-0 rounded-b-md z-[1000] max-h-[300px] flex flex-col">
          <div class="p-2 border-b border-[#21262d] flex gap-2 items-center">
            <input
              ref={inputRef}
              type="text"
              placeholder="Search models..."
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              class="flex-1 px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] text-[13px] focus:outline-none focus:border-[#58a6ff] placeholder:text-[#484f58]"
            />
            <Show when={!isLoading() && models().length > 0}>
              <span class="text-[11px] text-[#8b949e] whitespace-nowrap">
                {filteredModels().length} of {models().length}
              </span>
            </Show>
          </div>

          <div class="overflow-y-auto max-h-60">
            <Show when={isLoading()}>
              <div class="p-4 text-center text-[#8b949e] text-[13px]">
                Loading models from OpenRouter...
              </div>
            </Show>

            <Show when={!isLoading() && loadError()}>
              <div class="p-4 text-center text-[#f85149] text-[13px] flex flex-col gap-2 items-center">
                {loadError()}
                <button
                  type="button"
                  onClick={loadModels}
                  class="px-3 py-1 bg-transparent border border-[#30363d] rounded text-[#8b949e] text-xs cursor-pointer transition-all duration-150 hover:bg-[#21262d] hover:text-[#e6edf3]"
                >
                  Retry
                </button>
              </div>
            </Show>

            <Show
              when={
                !isLoading() && !loadError() && filteredModels().length === 0
              }
            >
              <div class="p-4 text-center text-[#8b949e] text-[13px]">
                No models match "{search()}"
              </div>
            </Show>

            <For each={filteredModels()}>
              {(model) => (
                <button
                  type="button"
                  class={`w-full flex justify-between items-center px-3 py-2.5 bg-transparent border-none text-[#e6edf3] text-sm cursor-pointer text-left transition-colors duration-100 hover:bg-[#21262d] ${
                    model.id === props.value ? "bg-[#1f6feb20]" : ""
                  }`}
                  onClick={() => handleSelect(model.id)}
                >
                  <span
                    class={`font-medium ${model.id === props.value ? "text-[#58a6ff]" : ""}`}
                  >
                    {model.name}
                  </span>
                  <span class="text-xs text-[#8b949e]">{model.provider}</span>
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
