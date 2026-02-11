// ABOUTME: Routes to the correct content view based on the active thread type.
// ABOUTME: Shows ChatContent for chat threads, AgentChat for agent threads, or empty state with remote sessions.

import {
  type Component,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { AgentChat } from "@/components/chat/AgentChat";
import { ChatContent } from "@/components/chat/ChatContent";
import { acpStore } from "@/stores/acp.store";
import { fileTreeState } from "@/stores/fileTree";
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
  const [showRemote, setShowRemote] = createSignal(false);

  const handleBrowse = async () => {
    setShowRemote(true);
    const cwd = fileTreeState.rootPath;
    if (cwd) {
      await acpStore.refreshRemoteSessions(cwd, acpStore.selectedAgentType);
    }
  };

  const handleResume = async (session: { sessionId: string; cwd: string }) => {
    const cwd = session.cwd || fileTreeState.rootPath;
    if (!cwd) return;
    await acpStore.resumeRemoteSession(
      session,
      cwd,
      acpStore.selectedAgentType,
    );
  };

  const handleLoadMore = async () => {
    const cwd = fileTreeState.rootPath;
    if (cwd) {
      await acpStore.loadMoreRemoteSessions(cwd, acpStore.selectedAgentType);
    }
  };

  const formatTime = (dateStr?: string | null) => {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    const diff = Date.now() - date.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
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

      {/* Remote session browser */}
      <Show
        when={showRemote()}
        fallback={
          <Show when={fileTreeState.rootPath}>
            <button
              type="button"
              class="thread-content__browse-btn"
              onClick={handleBrowse}
            >
              Browse Remote Sessions
            </button>
          </Show>
        }
      >
        <div class="thread-content__remote">
          <div class="thread-content__remote-header">
            <h3 class="thread-content__remote-title">Remote Sessions</h3>
            <button
              type="button"
              class="thread-content__remote-refresh"
              onClick={handleBrowse}
              disabled={acpStore.remoteSessionsLoading}
            >
              {acpStore.remoteSessionsLoading ? "Loading..." : "Refresh"}
            </button>
          </div>

          <Show when={acpStore.remoteSessionsError}>
            <p class="thread-content__remote-error">
              {acpStore.remoteSessionsError}
            </p>
          </Show>

          <Show
            when={acpStore.remoteSessions.length > 0}
            fallback={
              <Show when={!acpStore.remoteSessionsLoading}>
                <p class="thread-content__remote-empty">
                  No remote sessions found.
                </p>
              </Show>
            }
          >
            <div class="thread-content__remote-list">
              <For each={acpStore.remoteSessions}>
                {(session) => (
                  <button
                    type="button"
                    class="thread-content__remote-item"
                    onClick={() => handleResume(session)}
                  >
                    <span class="thread-content__remote-item-title">
                      {session.title ||
                        `Session ${session.sessionId.slice(0, 8)}`}
                    </span>
                    <span class="thread-content__remote-item-meta">
                      {formatTime(session.updatedAt)}
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>

          <Show when={acpStore.remoteSessionsNextCursor}>
            <button
              type="button"
              class="thread-content__browse-btn"
              onClick={handleLoadMore}
              disabled={acpStore.remoteSessionsLoading}
            >
              Load More
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
