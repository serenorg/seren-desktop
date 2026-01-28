// ABOUTME: Toggle component for switching between Chat and Agent modes.
// ABOUTME: Shows agent status and allows selection when in agent mode.

import type { Component } from "solid-js";
import { Show } from "solid-js";
import { acpStore } from "@/stores/acp.store";

export const AgentModeToggle: Component = () => {
  console.log("[AgentModeToggle] Rendering component");
  const isAgentMode = () => acpStore.agentModeEnabled;
  const hasActiveSession = () => acpStore.activeSession !== null;
  const sessionStatus = () => acpStore.activeSession?.info.status;

  const statusColor = () => {
    switch (sessionStatus()) {
      case "ready":
        return "bg-green-500";
      case "prompting":
        return "bg-yellow-500";
      case "initializing":
        return "bg-blue-500";
      case "error":
        return "bg-red-500";
      default:
        return "bg-gray-500";
    }
  };

  return (
    <div class="flex items-center gap-2">
      {/* Mode Toggle */}
      <div class="flex items-center bg-[#21262d] rounded-md p-0.5 border border-[#30363d]">
        <button
          type="button"
          class={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
            !isAgentMode()
              ? "bg-[#238636] text-white"
              : "bg-transparent text-[#e6edf3] hover:bg-[#30363d]"
          }`}
          onClick={() => acpStore.setAgentModeEnabled(false)}
        >
          Chat
        </button>
        <button
          type="button"
          class={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
            isAgentMode()
              ? "bg-[#8957e5] text-white"
              : "bg-transparent text-[#e6edf3] hover:bg-[#30363d]"
          }`}
          onClick={() => acpStore.setAgentModeEnabled(true)}
        >
          Agent
        </button>
      </div>

      {/* Agent Status Indicator */}
      <Show when={isAgentMode() && hasActiveSession()}>
        <div class="flex items-center gap-1.5">
          <span class={`w-2 h-2 rounded-full ${statusColor()}`} />
          <span class="text-xs text-[#8b949e] capitalize">
            {sessionStatus()}
          </span>
        </div>
      </Show>
    </div>
  );
};
