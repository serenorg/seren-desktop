// ABOUTME: Role-scoped reasoning-effort dropdown for paired Claude + Codex threads (#2368).
// ABOUTME: Renders only when that role's runtime reports a reasoning_effort select option.

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
  planner: "Planner effort",
  executor: "Executor effort",
};

export const PairedEffortSelector: Component<Props> = (props) => {
  const [isOpen, setIsOpen] = createSignal(false);
  let dropdownRef: HTMLDivElement | undefined;

  const roleStatus = () => props.session?.paired?.[props.pairedRole] ?? null;

  const option = () =>
    roleStatus()?.configOptions?.find(
      (o) => o.id === "reasoning_effort" && o.type === "select",
    ) ?? null;

  const optionValues = () => {
    const values = option()?.options;
    return Array.isArray(values) ? values : [];
  };

  const currentLabel = () => {
    const opt = option();
    if (!opt) return null;
    const current = optionValues().find((v) => v.value === opt.currentValue);
    return current?.name ?? opt.currentValue;
  };

  const selectValue = (valueId: string) => {
    void agentStore.setPairedConfigOption(
      props.pairedRole,
      "reasoning_effort",
      valueId,
      props.session?.info.id,
    );
    setIsOpen(false);
  };

  return (
    <Show when={option()}>
      <div class="relative" ref={dropdownRef}>
        <button
          type="button"
          class="flex items-center gap-1.5 px-2 py-1 bg-surface-2 border border-surface-3 rounded-md text-xs text-foreground cursor-pointer hover:bg-surface-3 transition-colors"
          onClick={() => setIsOpen(!isOpen())}
          title={`Change ${ROLE_LABELS[props.pairedRole].toLowerCase()}`}
        >
          <span class="font-medium max-w-[160px] truncate">
            {ROLE_LABELS[props.pairedRole]} · {currentLabel() ?? "default"}
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
          class="w-64"
        >
          <div class="px-3 py-2 border-b border-surface-2 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
            {ROLE_LABELS[props.pairedRole]} · {roleStatus()?.label}
          </div>
          <Show when={props.pairedRole === "planner"}>
            <div class="px-3 py-2 border-b border-surface-2 text-[11px] text-muted-foreground">
              Applies from the next planning session Claude spawns.
            </div>
          </Show>
          <For each={optionValues()}>
            {(opt) => (
              <button
                type="button"
                class={`w-full text-left px-3 py-2 border-b border-surface-2 last:border-b-0 transition-colors cursor-pointer hover:bg-surface-2 ${
                  opt.value === option()?.currentValue ? "bg-surface-2" : ""
                }`}
                onClick={() => selectValue(opt.value)}
              >
                <div class="flex items-center justify-between">
                  <span class="text-sm text-foreground">{opt.name}</span>
                  <Show when={opt.value === option()?.currentValue}>
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
        </FloatingSelectorMenu>
      </div>
    </Show>
  );
};
