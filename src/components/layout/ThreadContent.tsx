// ABOUTME: Routes to the correct content view based on the active thread type.
// ABOUTME: Shows ChatContent for chat threads, AgentChat for agent threads, or empty state.

import { type Component, Match, Switch } from "solid-js";
import { AgentChat } from "@/components/chat/AgentChat";
import { ChatContent } from "@/components/chat/ChatContent";
import { threadStore } from "@/stores/thread.store";

interface ThreadContentProps {
  onSignInClick: () => void;
}

export const ThreadContent: Component<ThreadContentProps> = (props) => {
  return (
    <div class="thread-content">
      <Switch fallback={<EmptyState />}>
        <Match when={threadStore.activeThreadKind === "chat"}>
          <ChatContent onSignInClick={props.onSignInClick} />
        </Match>
        <Match when={threadStore.activeThreadKind === "agent"}>
          <AgentChat />
        </Match>
      </Switch>
    </div>
  );
};

function EmptyState() {
  return (
    <div class="thread-content__empty">
      <div class="thread-content__empty-icon">
        <svg
          width="48"
          height="48"
          viewBox="0 0 48 48"
          fill="none"
          role="img"
          aria-label="No threads"
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
      <h2 class="thread-content__empty-title">No thread selected</h2>
      <p class="thread-content__empty-desc">
        Create a new chat or agent thread from the sidebar to get started.
      </p>
    </div>
  );
}
