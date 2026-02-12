// ABOUTME: Routes to the correct content view based on the active thread type.
// ABOUTME: Shows ChatContent for chat threads, AgentChat for agent threads, or empty state.

import { open } from "@tauri-apps/plugin-dialog";
import { type Component, Match, Show, Switch } from "solid-js";
import { AgentChat } from "@/components/chat/AgentChat";
import { ChatContent } from "@/components/chat/ChatContent";
import { ThreadTabBar } from "@/components/layout/ThreadTabBar";
import { fileTreeState, setRootPath } from "@/stores/fileTree";
import { threadStore } from "@/stores/thread.store";

interface ThreadContentProps {
  onSignInClick: () => void;
}

export const ThreadContent: Component<ThreadContentProps> = (props) => {
  return (
    <div class="thread-content">
      <ThreadTabBar />
      <div class="thread-content__body">
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
    <div class="thread-content__empty">
      <div class="thread-content__empty-icon">
        <svg
          width="48"
          height="48"
          viewBox="0 0 48 48"
          fill="none"
          role="img"
          aria-label="No skill selected"
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
      <h2 class="thread-content__empty-title">No skill selected</h2>
      <p class="thread-content__empty-desc">
        Create a new chat or agent skill from the sidebar to get started on
        building your skills.
      </p>

      <Show when={!fileTreeState.rootPath}>
        <button
          type="button"
          class="thread-content__browse-btn"
          onClick={handleOpenFolder}
        >
          Open Folder
        </button>
      </Show>
    </div>
  );
}
