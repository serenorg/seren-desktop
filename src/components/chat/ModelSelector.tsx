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
  untrack,
} from "solid-js";
import {
  getProviderIcon,
  PROVIDER_CONFIGS,
  type ProviderId,
  type ProviderModel,
} from "@/lib/providers";
import { type Model, modelsService } from "@/services/models";
import { allowsSerenPublicModels } from "@/services/organization-policy";
import { privateModelsService } from "@/services/private-models";
import { authStore } from "@/stores/auth.store";
import { chatStore } from "@/stores/chat.store";
import { conversationStore } from "@/stores/conversation.store";
import { AUTO_MODEL_ID, providerStore } from "@/stores/provider.store";

export const ModelSelector: Component = () => {
  const [isOpen, setIsOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [openRouterModels, setOpenRouterModels] = createSignal<Model[]>([]);
  const [isLoadingModels, setIsLoadingModels] = createSignal(false);
  const [privateModels, setPrivateModels] = createSignal<ProviderModel[]>([]);
  let containerRef: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;

  const isPrivateChat = createMemo(
    () => providerStore.activeProvider === "seren-private",
  );
  const currentProvider = () => providerStore.activeProvider;

  // Default models from provider store (curated list)
  const defaultModels = () => providerStore.getModels(currentProvider());

  // Load full model list from OpenRouter or private models catalog.
  createEffect(() => {
    const privatePolicy = authStore.privateChatPolicy;
    const privateEnabled = isPrivateChat();
    void (async () => {
      setIsLoadingModels(true);
      try {
        if (privateEnabled) {
          const models = await privateModelsService.listAvailable();
          setPrivateModels(models);

          const current = untrack(() => chatStore.selectedModel?.trim());
          const policyDefault = privatePolicy?.model_id?.trim();
          const hasCurrent =
            !!current && models.some((model) => model.id === current);
          if (!hasCurrent) {
            const fallback =
              (policyDefault &&
                models.find((model) => model.id === policyDefault)?.id) ||
              models[0]?.id;
            if (fallback) {
              chatStore.setModel(fallback);
            }
          }
          return;
        }

        const models = await modelsService.getAvailable();
        setOpenRouterModels(models);
      } catch (err) {
        console.error("Failed to load available models:", err);
      } finally {
        setIsLoadingModels(false);
      }
    })();
  });

  // Filter models: show defaults when no search, search full catalog when typing
  const filteredModels = createMemo(() => {
    const query = searchQuery().toLowerCase().trim();

    if (isPrivateChat()) {
      const models = privateModels();
      if (!query) {
        return models;
      }
      return models.filter(
        (model) =>
          model.name.toLowerCase().includes(query) ||
          model.id.toLowerCase().includes(query),
      );
    }

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
    if (isPrivateChat()) {
      const selected = chatStore.selectedModel;
      return (
        privateModels().find((model) => model.id === selected) ?? {
          id: selected,
          name:
            authStore.privateChatPolicy?.model_id === selected
              ? "Organization default"
              : selected || "Select private model",
          contextWindow: 0,
          description: "Private model",
        }
      );
    }

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
    const conversationId = conversationStore.activeConversationId;
    if (conversationId) {
      void conversationStore.updateConversationSelection(
        conversationId,
        modelId,
        providerStore.activeProvider,
      );
    }
    setIsOpen(false);
  };

  const selectProvider = (providerId: ProviderId) => {
    providerStore.setActiveProvider(providerId);
    // Update chat store with the first model of the new provider
    const models = providerStore.getModels(providerId);
    if (models.length > 0) {
      providerStore.setActiveModel(models[0].id);
      chatStore.setModel(models[0].id);
      const conversationId = conversationStore.activeConversationId;
      if (conversationId) {
        void conversationStore.updateConversationSelection(
          conversationId,
          models[0].id,
          providerId,
        );
      }
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

  if (isPrivateChat() && authStore.privateChatPolicy?.hide_model_picker) {
    return null;
  }

  return (
    <div class="relative" ref={containerRef}>
      <button
        class="flex items-center gap-2 px-3 py-1.5 bg-popover border border-muted rounded-md text-sm text-foreground cursor-pointer transition-colors hover:border-muted-foreground/40"
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
          when={!isPrivateChat() && providerStore.isAutoModel}
          fallback={
            <span class="inline-flex items-center justify-center w-[18px] h-[18px] bg-accent text-white rounded text-[11px] font-semibold">
              {getProviderIcon(currentProvider())}
            </span>
          }
        >
          <span class="inline-flex items-center justify-center w-[18px] h-[18px] bg-success/70 text-white rounded text-[11px] font-semibold">
            A
          </span>
        </Show>
        <span
          class={providerStore.isAutoModel ? "text-success" : "text-foreground"}
        >
          {currentModel()?.name || "Select model"}
        </span>
        <span class="text-[10px] text-muted-foreground">
          {isOpen() ? "▲" : "▼"}
        </span>
      </button>

      <Show when={isOpen()}>
        <div class="absolute bottom-[calc(100%+8px)] left-0 min-w-[320px] bg-surface-2 border border-surface-3 rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.5)] z-[1000] overflow-hidden">
          {/* Search input */}
          <div class="p-2 bg-surface-2 border-b border-surface-3">
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search models"
              value={searchQuery()}
              class="w-full px-3 py-2 bg-surface-3 border border-surface-3 rounded-md text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-accent"
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setIsOpen(false);
                }
              }}
            />
          </div>

          <Show
            when={!isPrivateChat()}
            fallback={
              <div class="flex items-center gap-2 p-2 bg-surface-3 border-b border-surface-3">
                <span class="inline-flex items-center justify-center w-4 h-4 bg-accent text-white rounded-sm text-[10px] font-semibold">
                  {getProviderIcon("seren")}
                </span>
                <span class="text-xs text-muted-foreground">
                  Organization private models
                </span>
              </div>
            }
          >
            <div class="flex gap-0.5 p-2 bg-surface-3 border-b border-surface-3 flex-wrap">
              <For each={providerStore.configuredProviders}>
                {(providerId) => (
                  <Show
                    when={
                      providerId !== "seren-private" &&
                      !(
                        providerId === "seren" &&
                        !allowsSerenPublicModels(authStore.privateChatPolicy)
                      ) &&
                      !(
                        providerId !== "seren" &&
                        authStore.privateChatPolicy
                          ?.disable_external_model_providers
                      )
                    }
                  >
                    <button
                      type="button"
                      class={`flex items-center gap-1 px-2.5 py-1.5 bg-transparent border border-transparent rounded text-xs text-muted-foreground cursor-pointer transition-all no-underline hover:bg-border hover:text-foreground ${providerId === currentProvider() ? "bg-primary/15 border-primary/40 text-accent" : ""}`}
                      onClick={() => {
                        selectProvider(providerId);
                        setSearchQuery("");
                      }}
                      title={PROVIDER_CONFIGS[providerId].name}
                    >
                      <span
                        class={`w-4 h-4 inline-flex items-center justify-center bg-surface-3 rounded-sm text-[10px] font-semibold ${providerId === currentProvider() ? "bg-accent text-white" : ""}`}
                      >
                        {getProviderIcon(providerId)}
                      </span>
                      <span class="max-w-[80px] overflow-hidden text-ellipsis whitespace-nowrap">
                        {PROVIDER_CONFIGS[providerId].name}
                      </span>
                    </button>
                  </Show>
                )}
              </For>
              <Show when={providerStore.getUnconfiguredProviders().length > 0}>
                <a
                  href="#"
                  class="flex items-center gap-1 px-2.5 py-1.5 bg-transparent border border-transparent rounded text-sm font-medium text-muted-foreground cursor-pointer transition-all no-underline hover:bg-primary/15 hover:text-accent"
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
          </Show>

          {/* Models for selected provider */}
          <div class="max-h-[300px] overflow-y-auto py-1 bg-surface-2">
            {/* Auto option — only when not searching and only for public models */}
            <Show when={!isPrivateChat() && !searchQuery()}>
              <button
                type="button"
                class={`w-full flex items-center justify-between gap-2 px-3 py-2 bg-transparent border-none text-left text-[13px] cursor-pointer transition-colors hover:bg-border border-b border-b-surface-3 ${providerStore.isAutoModel ? "bg-success/15" : ""}`}
                onClick={() => selectModel(AUTO_MODEL_ID)}
              >
                <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                  <span class="text-success font-medium">Auto</span>
                  <span class="text-[11px] text-muted-foreground">
                    Best model for each task
                  </span>
                </div>
                <Show when={providerStore.isAutoModel}>
                  <span class="text-success text-sm font-semibold">
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
                      : isPrivateChat()
                        ? "No private models available"
                        : `No models available for ${PROVIDER_CONFIGS[currentProvider()].name}`}
                </div>
              }
            >
              <For each={filteredModels()}>
                {(model) => (
                  <button
                    type="button"
                    class={`w-full flex items-center justify-between gap-2 px-3 py-2 bg-transparent border-none text-left text-[13px] cursor-pointer transition-colors hover:bg-border ${model.id === providerStore.activeModel ? "bg-primary/[0.12]" : ""}`}
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
                      <Show
                        when={
                          isPrivateChat()
                            ? model.id === chatStore.selectedModel
                            : model.id === providerStore.activeModel
                        }
                      >
                        <span class="text-success text-sm font-semibold">
                          &#10003;
                        </span>
                      </Show>
                      <Show when={model.contextWindow > 0}>
                        <span class="text-[11px] text-muted-foreground px-1.5 py-0.5 bg-surface-3 rounded whitespace-nowrap">
                          {formatContextWindow(model.contextWindow)}
                        </span>
                      </Show>
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
