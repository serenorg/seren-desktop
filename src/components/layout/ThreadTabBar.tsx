// ABOUTME: Horizontal tab bar for switching between chat and agent threads.
// ABOUTME: Shows thread tabs with icons, titles, status dots, close buttons, and a "+ New" dropdown.

import { type Component, createSignal, For, Show } from "solid-js";
import { fileTreeState } from "@/stores/fileTree";
import { type Thread, threadStore } from "@/stores/thread.store";
import "./ThreadTabBar.css";

export const ThreadTabBar: Component = () => {
  const [showNewMenu, setShowNewMenu] = createSignal(false);

  const handleSelect = (thread: Thread) => {
    threadStore.selectThread(thread.id, thread.kind);
  };

  const handleClose = (e: MouseEvent, thread: Thread) => {
    e.stopPropagation();
    threadStore.archiveThread(thread.id, thread.kind);
  };

  const handleNewChat = async () => {
    setShowNewMenu(false);
    await threadStore.createChatThread();
  };

  const handleNewAgent = async (agentType: "claude-code" | "codex") => {
    setShowNewMenu(false);
    const cwd = fileTreeState.rootPath;
    if (!cwd) return;
    await threadStore.createAgentThread(agentType, cwd);
  };

  const threadIcon = (thread: Thread) => {
    if (thread.kind === "chat") return "💬";
    return thread.agentType === "codex" ? "⚡" : "🤖";
  };

  return (
    <div class="thread-tab-bar">
      <div class="thread-tab-bar__tabs" role="tablist">
        <For each={threadStore.threads}>
          {(thread) => (
            <button
              type="button"
              role="tab"
              class="thread-tab-bar__tab"
              classList={{
                "thread-tab-bar__tab--active":
                  thread.id === threadStore.activeThreadId,
              }}
              aria-selected={thread.id === threadStore.activeThreadId}
              onClick={() => handleSelect(thread)}
              title={thread.title}
            >
              <span class="thread-tab-bar__tab-icon">{threadIcon(thread)}</span>
              <span class="thread-tab-bar__tab-title">{thread.title}</span>
              <Show when={thread.status === "running"}>
                <span class="thread-tab-bar__tab-status thread-tab-bar__tab-status--running" />
              </Show>
              <Show when={thread.status === "waiting-input"}>
                <span class="thread-tab-bar__tab-status thread-tab-bar__tab-status--waiting" />
              </Show>
              <Show when={thread.status === "error"}>
                <span class="thread-tab-bar__tab-status thread-tab-bar__tab-status--error" />
              </Show>
              <span
                role="button"
                tabindex={0}
                class="thread-tab-bar__tab-close"
                onClick={(e) => handleClose(e, thread)}
                onKeyDown={(e) => {
                  if (e.key === "Enter")
                    handleClose(e as unknown as MouseEvent, thread);
                }}
                title="Close thread"
              >
                ×
              </span>
            </button>
          )}
        </For>
      </div>

      {/* New thread button */}
      <div class="thread-tab-bar__new">
        <button
          type="button"
          class="thread-tab-bar__new-btn"
          onClick={() => setShowNewMenu((v) => !v)}
          title="New thread"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            role="img"
            aria-label="New thread"
          >
            <path
              d="M8 3v10M3 8h10"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
        </button>

        <Show when={showNewMenu()}>
          <div class="thread-tab-bar__new-menu">
            <button
              type="button"
              class="thread-tab-bar__new-menu-item"
              onClick={handleNewChat}
            >
              <span class="thread-tab-bar__new-menu-icon">💬</span>
              Chat
            </button>
            <button
              type="button"
              class="thread-tab-bar__new-menu-item"
              onClick={() => handleNewAgent("claude-code")}
              disabled={!fileTreeState.rootPath}
            >
              <span class="thread-tab-bar__new-menu-icon">🤖</span>
              Claude Agent
            </button>
            <button
              type="button"
              class="thread-tab-bar__new-menu-item"
              onClick={() => handleNewAgent("codex")}
              disabled={!fileTreeState.rootPath}
            >
              <span class="thread-tab-bar__new-menu-icon">⚡</span>
              Codex Agent
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
};
