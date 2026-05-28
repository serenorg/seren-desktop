// ABOUTME: Dropdown component for selecting the AI model in an agent session.
// ABOUTME: Shows available models reported by the active agent runtime and sends set_model commands.

import type { Component } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import { FloatingSelectorMenu } from "@/components/chat/FloatingSelectorMenu";
import {
  type ActiveSession,
  type AgentModelInfo,
  agentStore,
} from "@/stores/agent.store";

interface Props {
  session: ActiveSession | null;
}

export const AgentModelSelector: Component<Props> = (props) => {
  const [isOpen, setIsOpen] = createSignal(false);
  let dropdownRef: HTMLDivElement | undefined;

  const availableModels = () => props.session?.availableModels ?? [];
  const currentModelId = () => props.session?.currentModelId;
  const userSelectedModelId = () => props.session?.userSelectedModelId;

  // Picker label and the dropdown's "selected" checkmark both bind to the
  // user's sticky selection when present, falling back to the runtime's
  // currentModelId for sessions that have not had an explicit picker click
  // yet (initial state from `init`). This is what keeps the label from
  // flickering as `message.model` ground truth arrives turn-to-turn (#1729).
  const displayModelId = () => userSelectedModelId() ?? currentModelId();

  const currentModelName = () => {
    const id = displayModelId();
    if (!id) return null;
    const model = availableModels().find((m) => m.modelId === id);
    return model?.name ?? id;
  };

  const selectModel = (modelId: string) => {
    agentStore.setModel(modelId, props.session?.info.id);
    setIsOpen(false);
  };

  const capabilityBadges = (model: AgentModelInfo) =>
    [
      {
        label: "Fast",
        title: "Supports fast mode",
        visible: model.supportsFastMode === true,
      },
      {
        label: "Auto",
        title: "Supports auto permission mode",
        visible: model.supportsAutoMode === true,
      },
      {
        label: "Adaptive",
        title: "Supports adaptive thinking",
        visible: model.supportsAdaptiveThinking === true,
      },
    ].filter((badge) => badge.visible);

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

        <FloatingSelectorMenu
          open={isOpen()}
          anchor={() => dropdownRef}
          onRequestClose={() => setIsOpen(false)}
          class="w-80 max-w-[calc(100vw-2rem)]"
        >
          <div class="px-3 py-2 border-b border-surface-2 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
            Agent Model
          </div>
          <For each={availableModels()}>
            {(model) => (
              <button
                type="button"
                class={`w-full text-left px-3 py-2 border-b border-surface-2 last:border-b-0 transition-colors cursor-pointer hover:bg-surface-2 ${
                  model.modelId === displayModelId() ? "bg-surface-2" : ""
                }`}
                onClick={() => selectModel(model.modelId)}
              >
                <div class="flex items-center justify-between gap-2">
                  <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                    <span class="text-sm text-foreground font-medium">
                      {model.name}
                    </span>
                    <Show when={model.description}>
                      <span class="text-[11px] text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap">
                        {model.description}
                      </span>
                    </Show>
                  </div>
                  <div class="flex items-center justify-end gap-1 flex-shrink-0">
                    <For each={capabilityBadges(model)}>
                      {(badge) => (
                        <span
                          class="px-1.5 py-0.5 rounded border border-surface-3 bg-surface-1 text-[10px] leading-none text-muted-foreground font-medium"
                          title={badge.title}
                        >
                          {badge.label}
                        </span>
                      )}
                    </For>
                    <Show when={model.modelId === displayModelId()}>
                      <svg
                        class="w-4 h-4 text-green-500 flex-shrink-0"
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
                </div>
              </button>
            )}
          </For>
        </FloatingSelectorMenu>
      </div>
    </Show>
  );
};
