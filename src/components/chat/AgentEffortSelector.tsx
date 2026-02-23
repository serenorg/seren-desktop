// ABOUTME: Dropdown component for selecting agent reasoning effort (ACP config option).
// ABOUTME: Currently targets Codex's `reasoning_effort` session config option when available.

import type { Component } from "solid-js";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { type ActiveSession, acpStore } from "@/stores/acp.store";

interface Props {
  session: ActiveSession | null;
}

export const AgentEffortSelector: Component<Props> = (props) => {
  const [isOpen, setIsOpen] = createSignal(false);
  let dropdownRef: HTMLDivElement | undefined;

  const option = () =>
    props.session?.configOptions?.find(
      (o) => o.id === "reasoning_effort" && o.type === "select",
    ) ?? null;

  const currentLabel = () => {
    const opt = option();
    if (!opt) return null;
    const current = opt.options.find((v) => v.value === opt.currentValue);
    return current?.name ?? opt.currentValue;
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

  const selectValue = (valueId: string) => {
    acpStore.setConfigOption(
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
          title="Change reasoning effort"
        >
          <svg
            class="w-3 h-3 text-muted-foreground"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            role="img"
            aria-label="Effort"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 3v1m0 16v1m8-9h1M3 12H2m15.364-6.364l.707-.707M6.343 17.657l-.707.707m0-13.314l.707.707m11.314 11.314l-.707-.707"
            />
          </svg>
          <span class="font-medium max-w-[120px] truncate">
            {currentLabel() ?? "Effort"}
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
          <div class="absolute bottom-full left-0 mb-1 w-56 bg-surface-0 border border-surface-3 rounded-lg shadow-lg z-50 overflow-hidden">
            <div class="px-3 py-2 border-b border-surface-2 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              Reasoning Effort
            </div>
            <For each={option()?.options ?? []}>
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
          </div>
        </Show>
      </div>
    </Show>
  );
};
