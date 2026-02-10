// ABOUTME: Tab bar for managing multiple agent sessions.
// ABOUTME: Displays session tabs with permission indicators, close buttons, and agent type picker.

import {
  type Component,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { AgentType } from "@/services/acp";
import { acpStore } from "@/stores/acp.store";

interface AgentTabBarProps {
  onNewSession: (agentType?: AgentType) => void;
}

export const AgentTabBar: Component<AgentTabBarProps> = (props) => {
  const sessionIds = () => Object.keys(acpStore.sessions);
  const [showPicker, setShowPicker] = createSignal(false);
  let pickerRef: HTMLDivElement | undefined;

  const handleTabClick = (id: string) => {
    acpStore.setActiveSession(id);
  };

  const handleCloseTab = async (e: MouseEvent, id: string) => {
    e.stopPropagation();
    await acpStore.terminateSession(id);
  };

  const sessionLabel = (id: string, index: number) => {
    const session = acpStore.sessions[id];
    if (session?.title) return session.title;
    const agentType = session?.info?.agentType ?? "Agent";
    const label =
      agentType === "claude-code"
        ? "Claude"
        : agentType === "codex"
          ? "Codex"
          : agentType;
    return `${label} #${index + 1}`;
  };

  const availableAgents = () =>
    acpStore.availableAgents.filter((a) => a.available);

  // Check if a session has pending permission requests
  const sessionHasPendingPermissions = (sessionId: string) =>
    acpStore.pendingPermissions.some((p) => p.sessionId === sessionId) ||
    acpStore.pendingDiffProposals.some((p) => p.sessionId === sessionId);

  const handleNewClick = () => {
    const agents = availableAgents();
    if (agents.length <= 1) {
      props.onNewSession(agents[0]?.type);
      return;
    }
    setShowPicker(!showPicker());
  };

  const selectAgent = (type: AgentType) => {
    setShowPicker(false);
    props.onNewSession(type);
  };

  const handleClickOutside = (event: MouseEvent) => {
    if (pickerRef && !pickerRef.contains(event.target as Node)) {
      setShowPicker(false);
    }
  };

  onMount(() => {
    document.addEventListener("mousedown", handleClickOutside);
  });

  onCleanup(() => {
    document.removeEventListener("mousedown", handleClickOutside);
  });

  return (
    <div class="flex items-center gap-1 px-3 py-2 bg-[#161b22] border-b border-[#21262d] min-h-[40px]">
      <div class="flex items-center gap-1 flex-1 overflow-x-auto scrollbar-none [&::-webkit-scrollbar]:hidden">
        <For each={sessionIds()}>
          {(id: string, index) => (
            <button
              type="button"
              class={`group flex items-center gap-1.5 px-2.5 py-1.5 bg-transparent border border-transparent rounded-md text-[13px] text-[#8b949e] cursor-pointer whitespace-nowrap max-w-[180px] transition-all hover:bg-[rgba(139,148,158,0.1)] hover:text-[#e6edf3] ${id === acpStore.activeSessionId ? "bg-[rgba(88,166,255,0.1)] border-[rgba(88,166,255,0.3)] text-[#58a6ff]" : ""}`}
              onClick={() => handleTabClick(id)}
              title={sessionLabel(id, index())}
            >
              <Show when={sessionHasPendingPermissions(id)}>
                <span
                  class="permission-indicator"
                  title="Permission required"
                />
              </Show>
              <span class="overflow-hidden text-ellipsis max-w-[140px]">
                {sessionLabel(id, index())}
              </span>
              <Show when={sessionIds().length > 1}>
                <button
                  type="button"
                  class="flex items-center justify-center w-4 h-4 p-0 bg-transparent border-none rounded-sm text-sm leading-none text-[#8b949e] cursor-pointer opacity-0 transition-all group-hover:opacity-100 hover:bg-[rgba(248,81,73,0.2)] hover:text-[#f85149]"
                  onClick={(e) => handleCloseTab(e, id)}
                  title="Close session"
                >
                  ×
                </button>
              </Show>
            </button>
          )}
        </For>
      </div>
      <div class="relative" ref={pickerRef}>
        <button
          type="button"
          class="flex items-center justify-center w-7 h-7 p-0 bg-transparent border border-[#30363d] rounded-md text-lg leading-none text-[#8b949e] cursor-pointer shrink-0 transition-all hover:bg-[#21262d] hover:border-[#484f58] hover:text-[#e6edf3]"
          onClick={handleNewClick}
          title="New Agent Session"
        >
          +
        </button>
        <Show when={showPicker()}>
          <div class="absolute right-0 top-full mt-1 z-50 bg-[#161b22] border border-[#30363d] rounded-md shadow-lg min-w-[160px] py-1">
            <For each={availableAgents()}>
              {(agent) => (
                <button
                  type="button"
                  class="w-full px-3 py-2 text-left text-xs text-[#e6edf3] hover:bg-[#21262d] transition-colors cursor-pointer border-none bg-transparent"
                  onClick={() => selectAgent(agent.type)}
                >
                  <div class="font-medium">{agent.name}</div>
                  <div class="text-[#8b949e] mt-0.5">{agent.description}</div>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
};
