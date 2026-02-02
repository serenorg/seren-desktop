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
      <div class="flex items-center bg-[#161b22] rounded-lg p-0.5 border border-[#30363d]">
        <button
          type="button"
          class={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
            !isAgentMode()
              ? "bg-[#58a6ff]/15 text-[#58a6ff] shadow-[0_0_0_1px_rgba(88,166,255,0.3)]"
              : "bg-transparent text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]"
          }`}
          onClick={() => acpStore.setAgentModeEnabled(false)}
        >
          Chat
        </button>
        <button
          type="button"
          class={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
            isAgentMode()
              ? "bg-[#8957e5]/15 text-[#a371f7] shadow-[0_0_0_1px_rgba(137,87,229,0.3)]"
              : "bg-transparent text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]"
          }`}
          onClick={() => acpStore.setAgentModeEnabled(true)}
        >
          Agent
        </button>
      </div>

      {/* Agent Status Indicator */}
      <Show when={isAgentMode() && hasActiveSession()}>
        <div class="flex items-center gap-1.5">
          <span
            class={`w-2 h-2 rounded-full ${statusColor()} ${
              sessionStatus() === "prompting" || sessionStatus() === "initializing"
                ? "animate-pulse"
                : ""
            }`}
          />
          <span class="text-xs text-[#8b949e] capitalize">
            {sessionStatus()}
          </span>
        </div>
      </Show>
    </div>
  );
};
