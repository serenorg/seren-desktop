// ABOUTME: Dropdown component for selecting the permission mode in an agent session.
// ABOUTME: Shows available modes reported by the ACP agent and sends set_mode commands.

import type { Component } from "solid-js";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { type ActiveSession, acpStore } from "@/stores/acp.store";

interface Props {
  session: ActiveSession | null;
}

export const AgentModeSelector: Component<Props> = (props) => {
  const [isOpen, setIsOpen] = createSignal(false);
  let dropdownRef: HTMLDivElement | undefined;

  const availableModes = () => props.session?.availableModes ?? [];
  const currentModeId = () => props.session?.currentModeId;

  const currentModeName = () => {
    const id = currentModeId();
    if (!id) return null;
    const mode = availableModes().find((m) => m.modeId === id);
    return mode?.name ?? id;
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

  const selectMode = (modeId: string) => {
    acpStore.setPermissionMode(modeId, props.session?.info.id);
    setIsOpen(false);
  };

  return (
    <Show when={availableModes().length > 0}>
      <div class="relative" ref={dropdownRef}>
        <button
          type="button"
          class="flex items-center gap-1.5 px-2 py-1 bg-surface-2 border border-surface-3 rounded-md text-xs text-foreground cursor-pointer hover:bg-surface-3 transition-colors"
          onClick={() => setIsOpen(!isOpen())}
          title="Change permission mode"
        >
          <svg
            class="w-3 h-3 text-muted-foreground"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            role="img"
            aria-label="Mode"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
            />
          </svg>
          <span class="font-medium max-w-[120px] truncate">
            {currentModeName() ?? "Mode"}
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
          <div class="absolute bottom-full left-0 mb-1 w-72 bg-surface-0 border border-surface-3 rounded-lg shadow-lg z-50 overflow-hidden">
            <div class="px-3 py-2 border-b border-surface-2 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              Permission Mode
            </div>
            <For each={availableModes()}>
              {(mode) => (
                <button
                  type="button"
                  class={`w-full text-left px-3 py-2 border-b border-surface-2 last:border-b-0 transition-colors cursor-pointer hover:bg-surface-2 ${
                    mode.modeId === currentModeId() ? "bg-surface-2" : ""
                  }`}
                  onClick={() => selectMode(mode.modeId)}
                >
                  <div class="flex items-center justify-between">
                    <div class="flex flex-col gap-0.5">
                      <span class="text-sm text-foreground">{mode.name}</span>
                      <Show when={mode.description}>
                        <span class="text-[11px] text-muted-foreground">
                          {mode.description}
                        </span>
                      </Show>
                    </div>
                    <Show when={mode.modeId === currentModeId()}>
                      <svg
                        class="w-4 h-4 text-green-500 flex-shrink-0 ml-2"
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
