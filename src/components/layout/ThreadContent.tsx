// ABOUTME: Routes to the correct content view based on the active thread type.
// ABOUTME: Shows ChatContent for chat threads, AgentChat for agent threads, or empty state.

import { open } from "@tauri-apps/plugin-dialog";
import { type Component, Match, Show, Switch, createEffect } from "solid-js";
import { AgentChat } from "@/components/chat/AgentChat";
import { ChatContent } from "@/components/chat/ChatContent";
import { fileTreeState, setRootPath } from "@/stores/fileTree";
import { threadStore } from "@/stores/thread.store";

interface ThreadContentProps {
  onSignInClick: () => void;
}

export const ThreadContent: Component<ThreadContentProps> = (props) => {
  return (
    <div class="flex flex-col h-full overflow-hidden">
      <div class="flex-1 flex flex-col overflow-hidden min-h-0">
        <Switch fallback={<EmptyState />}>
          <Match when={threadStore.activeThreadKind === "chat"}>
            <ChatContent onSignInClick={props.onSignInClick} />
          </Match>
          <Match when={threadStore.activeThreadKind === "agent"}>
            <AgentChat />
          </Match>
        </Switch>
      </div>
    </div>
  );
};

function EmptyState() {
  const handleOpenFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      setRootPath(selected);
    }
  };

  return (
    <div class="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
      <div class="opacity-40">
        <svg
          width="48"
          height="48"
          viewBox="0 0 48 48"
          fill="none"
          role="img"
          aria-label="No thread selected"
        >
          <rect
            x="4"
            y="8"
            width="40"
            height="32"
            rx="4"
            stroke="currentColor"
            stroke-width="1.5"
            opacity="0.3"
          />
          <path
            d="M16 20h16M16 26h10"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            opacity="0.3"
          />
        </svg>
      </div>
      <h2 class="text-base font-medium text-foreground opacity-70 m-0">
        No thread selected
      </h2>
      <p class="text-[13px] opacity-50 m-0 max-w-[280px] text-center leading-relaxed">
        Create a new chat or agent thread from the sidebar to get started.
      </p>

      <Show when={!fileTreeState.rootPath}>
        <button
          type="button"
          class="mt-2 px-3.5 py-1.5 text-[13px] font-medium text-primary bg-primary/10 border border-transparent rounded-md cursor-pointer transition-all duration-100 hover:bg-primary/[0.18] hover:border-primary disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleOpenFolder}
        >
          Open Folder
        </button>
      </Show>
    </div>
  );
}
