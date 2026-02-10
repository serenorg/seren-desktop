// ABOUTME: Model selector dropdown for choosing AI models in chat.
// ABOUTME: Shows searchable model list from OpenRouter with provider filtering.

import type { Component } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  getProviderIcon,
  PROVIDER_CONFIGS,
  type ProviderId,
} from "@/lib/providers";
import { type Model, modelsService } from "@/services/models";
import { chatStore } from "@/stores/chat.store";
import { AUTO_MODEL_ID, providerStore } from "@/stores/provider.store";

export const ModelSelector: Component = () => {
  const [isOpen, setIsOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [openRouterModels, setOpenRouterModels] = createSignal<Model[]>([]);
  const [isLoadingModels, setIsLoadingModels] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;

  const currentProvider = () => providerStore.activeProvider;

  // Default models from provider store (curated list)
  const defaultModels = () => providerStore.getModels(currentProvider());

  // Load full model list from OpenRouter on mount (for search)
  onMount(async () => {
    setIsLoadingModels(true);
    try {
      const models = await modelsService.getAvailable();
      setOpenRouterModels(models);
    } catch (err) {
      console.error("Failed to load models from OpenRouter:", err);
    } finally {
      setIsLoadingModels(false);
    }
  });

  // Filter models: show defaults when no search, search full catalog when typing
  const filteredModels = createMemo(() => {
    const query = searchQuery().toLowerCase().trim();

    // No search query - show curated defaults
    if (!query) {
      return defaultModels();
    }

    // Searching - use full OpenRouter catalog for Seren provider
    if (currentProvider() === "seren" && openRouterModels().length > 0) {
      const allModels = openRouterModels().map((m) => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        description: m.provider,
      }));
      return allModels.filter(
        (model) =>
          model.name.toLowerCase().includes(query) ||
          model.id.toLowerCase().includes(query),
      );
    }

    // For other providers, search within their models
    return defaultModels().filter(
      (model) =>
        model.name.toLowerCase().includes(query) ||
        model.id.toLowerCase().includes(query),
    );
  });

  const currentModel = () => {
    const activeModel = providerStore.activeModel;
    if (activeModel === AUTO_MODEL_ID) {
      return { id: AUTO_MODEL_ID, name: "Auto", contextWindow: 0 };
    }

    const models = defaultModels();
    // First check defaults, then check full OpenRouter list for Seren
    const found = models.find((model) => model.id === activeModel);
    if (found) return found;

    // Check full catalog for Seren provider (user may have selected a non-default model)
    if (currentProvider() === "seren") {
      const orModel = openRouterModels().find((m) => m.id === activeModel);
      if (orModel) {
        return {
          id: orModel.id,
          name: orModel.name,
          contextWindow: orModel.contextWindow,
          description: orModel.provider,
        };
      }
    }

    return models[0];
  };

  const selectModel = (modelId: string) => {
    providerStore.setActiveModel(modelId);
    chatStore.setModel(modelId);
    setIsOpen(false);
  };

  const selectProvider = (providerId: ProviderId) => {
    providerStore.setActiveProvider(providerId);
    // Update chat store with the first model of the new provider
    const models = providerStore.getModels(providerId);
    if (models.length > 0) {
      chatStore.setModel(models[0].id);
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

  const formatContextWindow = (tokens: number): string => {
    if (tokens >= 1000000) {
      return `${(tokens / 1000000).toFixed(1)}M`;
    }
    return `${Math.round(tokens / 1000)}K`;
  };

  onMount(() => {
    document.addEventListener("click", handleDocumentClick);
  });

  onCleanup(() => {
    document.removeEventListener("click", handleDocumentClick);
  });

  // Sync chat store model with provider store
  createEffect(() => {
    const model = providerStore.activeModel;
    if (model && model !== chatStore.selectedModel) {
      chatStore.setModel(model);
    }
  });

  return (
    <div class="relative" ref={containerRef}>
      <button
        class="flex items-center gap-2 px-3 py-1.5 bg-popover border border-muted rounded-md text-sm text-foreground cursor-pointer transition-colors hover:border-[rgba(148,163,184,0.4)]"
        onClick={() => {
          const opening = !isOpen();
          setIsOpen(opening);
          if (opening) {
            setSearchQuery("");
            // Focus search input after dropdown opens
            setTimeout(() => searchInputRef?.focus(), 0);
          }
        }}
      >
        <Show
          when={providerStore.isAutoModel}
          fallback={
            <span class="inline-flex items-center justify-center w-[18px] h-[18px] bg-accent text-white rounded text-[11px] font-semibold">
              {getProviderIcon(currentProvider())}
            </span>
          }
        >
          <span class="inline-flex items-center justify-center w-[18px] h-[18px] bg-[#238636] text-white rounded text-[11px] font-semibold">
            A
          </span>
        </Show>
        <span class={providerStore.isAutoModel ? "text-[#7ee787]" : "text-foreground"}>
          {currentModel()?.name || "Select model"}
        </span>
        <span class="text-[10px] text-muted-foreground">
          {isOpen() ? "▲" : "▼"}
        </span>
      </button>

      <Show when={isOpen()}>
        <div class="absolute bottom-[calc(100%+8px)] left-0 min-w-[320px] bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.5)] z-[1000] overflow-hidden">
          {/* Search input */}
          <div class="p-2 bg-[#1e1e1e] border-b border-[#3c3c3c]">
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search models"
              value={searchQuery()}
              class="w-full px-3 py-2 bg-[#2d2d2d] border border-[#3c3c3c] rounded-md text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-accent"
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setIsOpen(false);
                }
              }}
            />
          </div>

          {/* Provider tabs */}
          <div class="flex gap-0.5 p-2 bg-[#252525] border-b border-[#3c3c3c] flex-wrap">
            <For each={providerStore.configuredProviders}>
              {(providerId) => (
                <button
                  type="button"
                  class={`flex items-center gap-1 px-2.5 py-1.5 bg-transparent border border-transparent rounded text-xs text-muted-foreground cursor-pointer transition-all no-underline hover:bg-[rgba(148,163,184,0.1)] hover:text-foreground ${providerId === currentProvider() ? "bg-[rgba(99,102,241,0.15)] border-[rgba(99,102,241,0.4)] text-accent" : ""}`}
                  onClick={() => {
                    selectProvider(providerId);
                    setSearchQuery("");
                  }}
                  title={PROVIDER_CONFIGS[providerId].name}
                >
                  <span
                    class={`w-4 h-4 inline-flex items-center justify-center bg-[#3c3c3c] rounded-sm text-[10px] font-semibold ${providerId === currentProvider() ? "bg-accent text-white" : ""}`}
                  >
                    {getProviderIcon(providerId)}
                  </span>
                  <span class="max-w-[80px] overflow-hidden text-ellipsis whitespace-nowrap">
                    {PROVIDER_CONFIGS[providerId].name}
                  </span>
                </button>
              )}
            </For>
            <Show when={providerStore.getUnconfiguredProviders().length > 0}>
              <a
                href="#"
                class="flex items-center gap-1 px-2.5 py-1.5 bg-transparent border border-transparent rounded text-sm font-medium text-muted-foreground cursor-pointer transition-all no-underline hover:bg-[rgba(99,102,241,0.15)] hover:text-accent"
                onClick={(e) => {
                  e.preventDefault();
                  setIsOpen(false);
                }}
                title="Add provider"
              >
                +
              </a>
            </Show>
          </div>

          {/* Models for selected provider */}
          <div class="max-h-[300px] overflow-y-auto py-1 bg-[#1e1e1e]">
            {/* Auto option — only when not searching */}
            <Show when={!searchQuery()}>
              <button
                type="button"
                class={`w-full flex items-center justify-between gap-2 px-3 py-2 bg-transparent border-none text-left text-[13px] cursor-pointer transition-colors hover:bg-[rgba(148,163,184,0.1)] border-b border-b-[#3c3c3c] ${providerStore.isAutoModel ? "bg-[rgba(34,134,54,0.15)]" : ""}`}
                onClick={() => selectModel(AUTO_MODEL_ID)}
              >
                <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                  <span class="text-[#7ee787] font-medium">Auto</span>
                  <span class="text-[11px] text-muted-foreground">
                    Best model for each task
                  </span>
                </div>
                <Show when={providerStore.isAutoModel}>
                  <span class="text-[#7ee787] text-sm font-semibold">
                    &#10003;
                  </span>
                </Show>
              </button>
            </Show>
            <Show
              when={filteredModels().length > 0}
              fallback={
                <div class="p-4 text-center text-muted-foreground text-[13px]">
                  {isLoadingModels()
                    ? "Loading models..."
                    : searchQuery()
                      ? `No models matching "${searchQuery()}"`
                      : `No models available for ${PROVIDER_CONFIGS[currentProvider()].name}`}
                </div>
              }
            >
              <For each={filteredModels()}>
                {(model) => (
                  <button
                    type="button"
                    class={`w-full flex items-center justify-between gap-2 px-3 py-2 bg-transparent border-none text-left text-[13px] cursor-pointer transition-colors hover:bg-[rgba(148,163,184,0.1)] ${model.id === providerStore.activeModel ? "bg-[rgba(99,102,241,0.12)]" : ""}`}
                    onClick={() => selectModel(model.id)}
                  >
                    <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                      <span class="text-foreground font-medium">
                        {model.name}
                      </span>
                      <Show when={model.description}>
                        <span class="text-[11px] text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap">
                          {model.description}
                        </span>
                      </Show>
                    </div>
                    <div class="flex items-center gap-2">
                      <Show when={model.id === providerStore.activeModel}>
                        <span class="text-success text-sm font-semibold">
                          &#10003;
                        </span>
                      </Show>
                      <span class="text-[11px] text-[#94a3b8] px-1.5 py-0.5 bg-[#2d2d2d] rounded whitespace-nowrap">
                        {formatContextWindow(model.contextWindow)}
                      </span>
                    </div>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default ModelSelector;
