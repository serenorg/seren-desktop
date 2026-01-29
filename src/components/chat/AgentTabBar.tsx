// ABOUTME: Tab bar for managing multiple agent sessions.
// ABOUTME: Displays session tabs with close buttons and a new session button.

import { type Component, For, Show } from "solid-js";
import { acpStore } from "@/stores/acp.store";

interface AgentTabBarProps {
  onNewSession: () => void;
}

export const AgentTabBar: Component<AgentTabBarProps> = (props) => {
  const sessionIds = () => Object.keys(acpStore.sessions);

  const handleTabClick = (id: string) => {
    acpStore.setActiveSession(id);
  };

  const handleCloseTab = async (e: MouseEvent, id: string) => {
    e.stopPropagation();
    await acpStore.terminateSession(id);
  };

  const sessionLabel = (id: string, index: number) => {
    const session = acpStore.sessions[id];
    const agentType = session?.info?.agentType ?? "Agent";
    const label = agentType === "claude-code" ? "Claude" : agentType;
    return `${label} #${index + 1}`;
  };

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
      <button
        type="button"
        class="flex items-center justify-center w-7 h-7 p-0 bg-transparent border border-[#30363d] rounded-md text-lg leading-none text-[#8b949e] cursor-pointer shrink-0 transition-all hover:bg-[#21262d] hover:border-[#484f58] hover:text-[#e6edf3]"
        onClick={props.onNewSession}
        title="New Agent Session"
      >
        +
      </button>
    </div>
  );
};
