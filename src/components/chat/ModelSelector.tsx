// ABOUTME: Model selector dropdown for choosing AI models in chat.
// ABOUTME: Shows provider tabs and models from the active provider.

import type { Component } from "solid-js";
import { createSignal, For, onCleanup, onMount, Show, createEffect } from "solid-js";
import { chatStore } from "@/stores/chat.store";
import { providerStore } from "@/stores/provider.store";
import {
  PROVIDER_CONFIGS,
  getProviderIcon,
  type ProviderId,
} from "@/lib/providers";
import "./ModelSelector.css";

export const ModelSelector: Component = () => {
  const [isOpen, setIsOpen] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;

  const currentProvider = () => providerStore.activeProvider;
  const availableModels = () => providerStore.getModels(currentProvider());

  const currentModel = () => {
    const models = availableModels();
    const activeModel = providerStore.activeModel;
    return models.find((model) => model.id === activeModel) || models[0];
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
    if (containerRef && event.target instanceof Node && !containerRef.contains(event.target)) {
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
    <div class="model-selector" ref={containerRef}>
      <button class="model-selector-trigger" onClick={() => setIsOpen(!isOpen())}>
        <span class="provider-badge-small">{getProviderIcon(currentProvider())}</span>
        <span class="model-name">{currentModel()?.name || "Select model"}</span>
        <span class="chevron">{isOpen() ? "▲" : "▼"}</span>
      </button>

      <Show when={isOpen()}>
        <div class="model-selector-dropdown">
          {/* Provider tabs */}
          <div class="provider-tabs">
            <For each={providerStore.configuredProviders}>
              {(providerId) => (
                <button
                  type="button"
                  class={`provider-tab ${providerId === currentProvider() ? "active" : ""}`}
                  onClick={() => selectProvider(providerId)}
                  title={PROVIDER_CONFIGS[providerId].name}
                >
                  <span class="provider-tab-icon">{getProviderIcon(providerId)}</span>
                  <span class="provider-tab-name">{PROVIDER_CONFIGS[providerId].name}</span>
                </button>
              )}
            </For>
            <Show when={providerStore.getUnconfiguredProviders().length > 0}>
              <a
                href="#"
                class="provider-tab add-provider"
                onClick={(e) => {
                  e.preventDefault();
                  // Navigate to settings (this would typically use a router or context)
                  // For now, close dropdown and let user navigate manually
                  setIsOpen(false);
                  // Emit event or callback to open settings
                }}
                title="Add provider"
              >
                +
              </a>
            </Show>
          </div>

          {/* Models for selected provider */}
          <div class="model-list">
            <Show
              when={availableModels().length > 0}
              fallback={
                <div class="model-list-empty">
                  No models available for {PROVIDER_CONFIGS[currentProvider()].name}
                </div>
              }
            >
              <For each={availableModels()}>
                {(model) => (
                  <button
                    type="button"
                    class={`model-option ${model.id === providerStore.activeModel ? "selected" : ""}`}
                    onClick={() => selectModel(model.id)}
                  >
                    <div class="model-info">
                      <span class="model-name">{model.name}</span>
                      <Show when={model.description}>
                        <span class="model-description">{model.description}</span>
                      </Show>
                    </div>
                    <span class="model-context">{formatContextWindow(model.contextWindow)}</span>
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
