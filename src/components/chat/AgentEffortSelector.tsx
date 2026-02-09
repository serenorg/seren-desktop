// ABOUTME: Dropdown component for selecting agent reasoning effort (ACP config option).
// ABOUTME: Currently targets Codex's `reasoning_effort` session config option when available.

import type { Component } from "solid-js";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { acpStore } from "@/stores/acp.store";

export const AgentEffortSelector: Component = () => {
  const [isOpen, setIsOpen] = createSignal(false);
  let dropdownRef: HTMLDivElement | undefined;

  const option = () =>
    acpStore.activeSession?.configOptions?.find(
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
    acpStore.setConfigOption("reasoning_effort", valueId);
    setIsOpen(false);
  };

  return (
    <Show when={option()}>
      <div class="relative" ref={dropdownRef}>
        <button
          type="button"
          class="flex items-center gap-1.5 px-2 py-1 bg-[#21262d] border border-[#30363d] rounded-md text-xs text-[#e6edf3] cursor-pointer hover:bg-[#30363d] transition-colors"
          onClick={() => setIsOpen(!isOpen())}
          title="Change reasoning effort"
        >
          <svg
            class="w-3 h-3 text-[#8b949e]"
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
            class={`w-3 h-3 text-[#8b949e] transition-transform ${isOpen() ? "rotate-180" : ""}`}
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
          <div class="absolute bottom-full left-0 mb-1 w-56 bg-[#161b22] border border-[#30363d] rounded-lg shadow-lg z-50 overflow-hidden">
            <div class="px-3 py-2 border-b border-[#21262d] text-[10px] uppercase tracking-wider text-[#8b949e] font-medium">
              Reasoning Effort
            </div>
            <For each={option()?.options ?? []}>
              {(opt) => (
                <button
                  type="button"
                  class={`w-full text-left px-3 py-2 border-b border-[#21262d] last:border-b-0 transition-colors cursor-pointer hover:bg-[#21262d] ${
                    opt.value === option()?.currentValue ? "bg-[#21262d]" : ""
                  }`}
                  onClick={() => selectValue(opt.value)}
                >
                  <div class="flex items-center justify-between">
                    <span class="text-sm text-[#e6edf3]">{opt.name}</span>
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
