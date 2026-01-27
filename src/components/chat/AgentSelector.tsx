// ABOUTME: Dropdown component for selecting which AI agent to use.
// ABOUTME: Shows available agents with their status and descriptions.

import type { Component } from "solid-js";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { AgentType } from "@/services/acp";
import { acpStore } from "@/stores/acp.store";

export const AgentSelector: Component = () => {
  const [isOpen, setIsOpen] = createSignal(false);
  let dropdownRef: HTMLDivElement | undefined;

  const selectedAgent = () => {
    const type = acpStore.selectedAgentType;
    return acpStore.availableAgents.find((a) => a.type === type);
  };

  const handleClickOutside = (event: MouseEvent) => {
    if (dropdownRef && !dropdownRef.contains(event.target as Node)) {
      setIsOpen(false);
    }
  };

  onMount(() => {
    document.addEventListener("mousedown", handleClickOutside);
    // Initialize available agents list
    acpStore.initialize();
  });

  onCleanup(() => {
    document.removeEventListener("mousedown", handleClickOutside);
  });

  const selectAgent = (type: AgentType) => {
    acpStore.setSelectedAgentType(type);
    setIsOpen(false);
  };

  return (
    <div class="relative" ref={dropdownRef}>
      <button
        type="button"
        class="flex items-center gap-2 px-3 py-1.5 bg-[#21262d] border border-[#30363d] rounded-md text-xs text-[#e6edf3] cursor-pointer hover:bg-[#30363d] transition-colors"
        onClick={() => setIsOpen(!isOpen())}
      >
        <span class="font-medium">
          {selectedAgent()?.name ?? "Select Agent"}
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
        <div class="absolute top-full left-0 mt-1 w-64 bg-[#161b22] border border-[#30363d] rounded-lg shadow-lg z-50 overflow-hidden">
          <For each={acpStore.availableAgents}>
            {(agent) => (
              <button
                type="button"
                class={`w-full text-left px-3 py-2.5 border-b border-[#21262d] last:border-b-0 transition-colors ${
                  agent.available
                    ? "cursor-pointer hover:bg-[#21262d]"
                    : "cursor-not-allowed opacity-50"
                } ${
                  agent.type === acpStore.selectedAgentType
                    ? "bg-[#21262d]"
                    : ""
                }`}
                onClick={() =>
                  agent.available && selectAgent(agent.type as AgentType)
                }
                disabled={!agent.available}
              >
                <div class="flex items-center justify-between mb-1">
                  <span class="text-sm font-medium text-[#e6edf3]">
                    {agent.name}
                  </span>
                  <Show when={!agent.available}>
                    <span class="text-[10px] px-1.5 py-0.5 bg-[#30363d] text-[#8b949e] rounded">
                      Coming Soon
                    </span>
                  </Show>
                  <Show
                    when={
                      agent.available &&
                      agent.type === acpStore.selectedAgentType
                    }
                  >
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
                <p class="text-xs text-[#8b949e] m-0">{agent.description}</p>
                <Show when={!agent.available && agent.unavailableReason}>
                  <p class="text-[10px] text-[#f85149] m-0 mt-1">
                    {agent.unavailableReason}
                  </p>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};
