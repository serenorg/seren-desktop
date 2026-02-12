// ABOUTME: Dropdown component for selecting the AI model in an agent session.
// ABOUTME: Shows available models reported by the ACP agent and sends set_model commands.

import type { Component } from "solid-js";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { acpStore } from "@/stores/acp.store";

export const AgentModelSelector: Component = () => {
  const [isOpen, setIsOpen] = createSignal(false);
  let dropdownRef: HTMLDivElement | undefined;

  const availableModels = () => acpStore.activeSession?.availableModels ?? [];
  const currentModelId = () => acpStore.activeSession?.currentModelId;

  const currentModelName = () => {
    const id = currentModelId();
    if (!id) return null;
    const model = availableModels().find((m) => m.modelId === id);
    return model?.name ?? id;
  };

  const handleClickOutside = (event: MouseEvent) => {
    if (dropdownRef && !dropdownRef.contains(event.target as Node)) {
      setIsOpen(false);
    }
  };

  onMount(() => {
    document.addEventListener("mousedown", handleClickOutside);
  });

  onCleanup(() => {
    document.removeEventListener("mousedown", handleClickOutside);
  });

  const selectModel = (modelId: string) => {
    acpStore.setModel(modelId);
    setIsOpen(false);
  };

  return (
    <Show when={availableModels().length > 0}>
      <div class="relative" ref={dropdownRef}>
        <button
          type="button"
          class="flex items-center gap-1.5 px-2 py-1 bg-surface-2 border border-surface-3 rounded-md text-xs text-foreground cursor-pointer hover:bg-surface-3 transition-colors"
          onClick={() => setIsOpen(!isOpen())}
          title="Change model"
        >
          <svg
            class="w-3 h-3 text-muted-foreground"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            role="img"
            aria-label="Model"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
            />
          </svg>
          <span class="font-medium max-w-[120px] truncate">
            {currentModelName() ?? "Model"}
          </span>
          <svg
            class={`w-3 h-3 text-muted-foreground transition-transform ${isOpen() ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            role="img"
            aria-label="Toggle dropdown"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </button>

        <Show when={isOpen()}>
          <div class="absolute bottom-full left-0 mb-1 w-64 bg-surface-0 border border-surface-3 rounded-lg shadow-lg z-50 overflow-hidden">
            <div class="px-3 py-2 border-b border-surface-2 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              Agent Model
            </div>
            <For each={availableModels()}>
              {(model) => (
                <button
                  type="button"
                  class={`w-full text-left px-3 py-2 border-b border-surface-2 last:border-b-0 transition-colors cursor-pointer hover:bg-surface-2 ${
                    model.modelId === currentModelId() ? "bg-surface-2" : ""
                  }`}
                  onClick={() => selectModel(model.modelId)}
                >
                  <div class="flex items-center justify-between">
                    <span class="text-sm text-foreground">{model.name}</span>
                    <Show when={model.modelId === currentModelId()}>
                      <svg
                        class="w-4 h-4 text-green-500"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                        role="img"
                        aria-label="Selected"
                      >
                        <path
                          fill-rule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clip-rule="evenodd"
                        />
                      </svg>
                    </Show>
                  </div>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
};
