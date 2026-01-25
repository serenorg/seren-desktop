import type { Component } from "solid-js";
import { createSignal, For, onCleanup, onMount } from "solid-js";
import { chatStore } from "@/stores/chat.store";
import { modelsService, type Model } from "@/services/models";
import "./ModelSelector.css";

const FALLBACK_MODELS: Model[] = [
  {
    id: "anthropic/claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    provider: "Anthropic",
    contextWindow: 200000,
  },
  {
    id: "anthropic/claude-3-opus-20240229",
    name: "Claude 3 Opus",
    provider: "Anthropic",
    contextWindow: 200000,
  },
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    provider: "OpenAI",
    contextWindow: 128000,
  },
  {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o Mini",
    provider: "OpenAI",
    contextWindow: 128000,
  },
];

export const ModelSelector: Component = () => {
  const [isOpen, setIsOpen] = createSignal(false);
  const [availableModels, setAvailableModels] = createSignal<Model[]>(FALLBACK_MODELS);
  let containerRef: HTMLDivElement | undefined;

  const currentModel = () =>
    availableModels().find((model) => model.id === chatStore.selectedModel) ||
    availableModels()[0];

  const selectModel = (modelId: string) => {
    chatStore.setModel(modelId);
    setIsOpen(false);
  };

  const handleDocumentClick = (event: MouseEvent) => {
    if (!isOpen()) return;
    if (containerRef && event.target instanceof Node && !containerRef.contains(event.target)) {
      setIsOpen(false);
    }
  };

  onMount(async () => {
    document.addEventListener("click", handleDocumentClick);
    try {
      const models = await modelsService.getAvailable();
      if (models.length > 0) {
        setAvailableModels(models);
      }
    } catch {
      // Ignore, fallback already set
    }
  });

  onCleanup(() => {
    document.removeEventListener("click", handleDocumentClick);
  });

  return (
    <div class="model-selector" ref={containerRef}>
      <button class="model-selector-trigger" onClick={() => setIsOpen(!isOpen())}>
        <span class="model-name">{currentModel()?.name}</span>
        <span class="chevron">{isOpen() ? "▲" : "▼"}</span>
      </button>

      {isOpen() && (
        <div class="model-selector-dropdown">
          <For each={availableModels()}>
            {(model) => (
              <button
                class={`model-option ${model.id === chatStore.selectedModel ? "selected" : ""}`}
                onClick={() => selectModel(model.id)}
              >
                <span class="model-name">{model.name}</span>
                <span class="model-provider">{model.provider}</span>
              </button>
            )}
          </For>
        </div>
      )}
    </div>
  );
};
