// ABOUTME: Role-scoped model dropdown for paired Claude + Codex threads (#2368).
// ABOUTME: Shows "Planner · <model>" / "Executor · <model>" and routes set_model to that role only.

import type { Component } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import { FloatingSelectorMenu } from "@/components/chat/FloatingSelectorMenu";
import type { PairedRole } from "@/services/providers";
import { type ActiveSession, agentStore } from "@/stores/agent.store";

interface Props {
  session: ActiveSession | null;
  pairedRole: PairedRole;
}

const ROLE_LABELS: Record<PairedRole, string> = {
  planner: "Planner",
  executor: "Executor",
};

export const PairedModelSelector: Component<Props> = (props) => {
  const [isOpen, setIsOpen] = createSignal(false);
  let dropdownRef: HTMLDivElement | undefined;

  const roleStatus = () => props.session?.paired?.[props.pairedRole] ?? null;
  const availableModels = () => {
    const models = roleStatus()?.models?.availableModels;
    return Array.isArray(models) ? models : [];
  };
  const currentModelId = () => roleStatus()?.models?.currentModelId;

  const currentModelName = () => {
    const id = currentModelId();
    if (!id) return null;
    const model = availableModels().find((m) => m.modelId === id);
    return model?.name ?? id;
  };

  // "Planner · Claude Default · Fable 5" when floating on the provider
  // default; "Planner · Fable 5" once the user pins an explicit model.
  const buttonLabel = () => {
    const status = roleStatus();
    const model = currentModelName();
    if (!status) return ROLE_LABELS[props.pairedRole];
    if (!model)
      return `${ROLE_LABELS[props.pairedRole]} · ${status.defaultModelLabel}`;
    return status.pinnedModelId
      ? `${ROLE_LABELS[props.pairedRole]} · ${model}`
      : `${ROLE_LABELS[props.pairedRole]} · ${status.defaultModelLabel} · ${model}`;
  };

  const selectModel = (modelId: string) => {
    void agentStore.setPairedModel(
      props.pairedRole,
      modelId,
      props.session?.info.id,
    );
    setIsOpen(false);
  };

  return (
    <Show when={availableModels().length > 0}>
      <div class="relative" ref={dropdownRef}>
        <button
          type="button"
          class="flex items-center gap-1.5 px-2 py-1 bg-surface-2 border border-surface-3 rounded-md text-xs text-foreground cursor-pointer hover:bg-surface-3 transition-colors"
          onClick={() => setIsOpen(!isOpen())}
          title={`Change ${ROLE_LABELS[props.pairedRole].toLowerCase()} model`}
        >
          <span class="font-medium max-w-[200px] truncate">
            {buttonLabel()}
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
            {ROLE_LABELS[props.pairedRole]} Model · {roleStatus()?.label}
          </div>
          <Show when={roleStatus()?.notice}>
            <div class="px-3 py-2 border-b border-surface-2 text-[11px] text-warning">
              {roleStatus()?.notice}
            </div>
          </Show>
          <For each={availableModels()}>
            {(model) => (
              <button
                type="button"
                class={`w-full text-left px-3 py-2 border-b border-surface-2 last:border-b-0 transition-colors cursor-pointer hover:bg-surface-2 ${
                  model.modelId === currentModelId() ? "bg-surface-2" : ""
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
                  <Show when={model.modelId === currentModelId()}>
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
              </button>
            )}
          </For>
        </FloatingSelectorMenu>
      </div>
    </Show>
  );
};
