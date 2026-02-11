// ABOUTME: Left sidebar with project header and unified thread list.
// ABOUTME: Displays all chat and agent threads for the active project, sorted by recency.

import { open } from "@tauri-apps/plugin-dialog";
import { type Component, createSignal, For, Show } from "solid-js";
import { fileTreeState, setRootPath } from "@/stores/fileTree";
import { type Thread, threadStore } from "@/stores/thread.store";
import "./ThreadSidebar.css";

interface ThreadSidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export const ThreadSidebar: Component<ThreadSidebarProps> = (props) => {
  const [showNewMenu, setShowNewMenu] = createSignal(false);

  const folderName = () => {
    const root = fileTreeState.rootPath;
    if (!root) return null;
    return root.split("/").pop() || root;
  };

  const handleOpenFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      setRootPath(selected);
    }
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

  const handleSelectThread = (thread: Thread) => {
    threadStore.selectThread(thread.id, thread.kind);
  };

  const formatTime = (timestamp: number) => {
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d`;
    return new Date(timestamp).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  };

  return (
    <aside
      class="thread-sidebar"
      classList={{ "thread-sidebar--collapsed": props.collapsed }}
    >
      {/* Project header */}
      <div class="thread-sidebar__header">
        <Show
          when={folderName()}
          fallback={
            <button
              class="thread-sidebar__open-folder"
              onClick={handleOpenFolder}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                role="img"
                aria-label="Folder"
              >
                <path
                  d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 2h5A1.5 1.5 0 0114 6.5v5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z"
                  stroke="currentColor"
                  stroke-width="1.2"
                />
              </svg>
              Open Folder
            </button>
          }
        >
          <div class="thread-sidebar__project">
            <button
              class="thread-sidebar__project-name"
              onClick={handleOpenFolder}
              title={fileTreeState.rootPath || ""}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                role="img"
                aria-label="Folder"
              >
                <path
                  d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 2h5A1.5 1.5 0 0114 6.5v5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z"
                  stroke="currentColor"
                  stroke-width="1.2"
                />
              </svg>
              {folderName()}
            </button>
          </div>
        </Show>

        {/* Collapse toggle */}
        <button
          class="thread-sidebar__collapse-btn"
          onClick={props.onToggle}
          title="Toggle sidebar"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            role="img"
            aria-label="Menu"
          >
            <path
              d="M3 4h10M3 8h10M3 12h10"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>

      {/* New thread button */}
      <div class="thread-sidebar__new">
        <button
          class="thread-sidebar__new-btn"
          onClick={() => setShowNewMenu((v) => !v)}
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
          New Thread
        </button>

        <Show when={showNewMenu()}>
          <div class="thread-sidebar__new-menu">
            <button
              class="thread-sidebar__new-menu-item"
              onClick={handleNewChat}
            >
              <span class="thread-sidebar__new-menu-icon">💬</span>
              Chat
            </button>
            <button
              class="thread-sidebar__new-menu-item"
              onClick={() => handleNewAgent("claude-code")}
              disabled={!fileTreeState.rootPath}
            >
              <span class="thread-sidebar__new-menu-icon">🤖</span>
              Claude Agent
            </button>
            <button
              class="thread-sidebar__new-menu-item"
              onClick={() => handleNewAgent("codex")}
              disabled={!fileTreeState.rootPath}
            >
              <span class="thread-sidebar__new-menu-icon">⚡</span>
              Codex Agent
            </button>
          </div>
        </Show>
      </div>

      {/* Thread list grouped by project */}
      <div class="thread-sidebar__list">
        <Show
          when={threadStore.groupedThreads.length > 0}
          fallback={
            <div class="thread-sidebar__empty">
              <p>No threads yet</p>
            </div>
          }
        >
          <For each={threadStore.groupedThreads}>
            {(group) => (
              <div class="thread-sidebar__group">
                <Show when={threadStore.groupedThreads.length > 1}>
                  <div
                    class="thread-sidebar__group-header"
                    classList={{
                      "thread-sidebar__group-header--current":
                        group.projectRoot === fileTreeState.rootPath,
                    }}
                    title={group.projectRoot || undefined}
                  >
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 16 16"
                      fill="none"
                      role="img"
                      aria-label="Folder"
                    >
                      <path
                        d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 2h5A1.5 1.5 0 0114 6.5v5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z"
                        stroke="currentColor"
                        stroke-width="1.2"
                      />
                    </svg>
                    <span class="thread-sidebar__group-name">
                      {group.folderName}
                    </span>
                    <span class="thread-sidebar__group-count">
                      {group.threads.length}
                    </span>
                  </div>
                </Show>
                <For each={group.threads}>
                  {(thread) => (
                    <button
                      class="thread-sidebar__item"
                      classList={{
                        "thread-sidebar__item--active":
                          thread.id === threadStore.activeThreadId,
                        "thread-sidebar__item--running":
                          thread.status === "running",
                      }}
                      onClick={() => handleSelectThread(thread)}
                    >
                      <div class="thread-sidebar__item-icon">
                        <Show
                          when={thread.kind === "agent"}
                          fallback={
                            <span class="thread-sidebar__kind-badge thread-sidebar__kind-badge--chat">
                              💬
                            </span>
                          }
                        >
                          <span class="thread-sidebar__kind-badge thread-sidebar__kind-badge--agent">
                            {thread.agentType === "codex" ? "⚡" : "🤖"}
                          </span>
                        </Show>
                      </div>
                      <div class="thread-sidebar__item-content">
                        <span class="thread-sidebar__item-title">
                          {thread.title}
                        </span>
                        <span class="thread-sidebar__item-meta">
                          {formatTime(thread.timestamp)}
                        </span>
                      </div>
                      <Show when={thread.status === "running"}>
                        <span class="thread-sidebar__status-dot thread-sidebar__status-dot--running" />
                      </Show>
                      <Show when={thread.status === "waiting-input"}>
                        <span class="thread-sidebar__status-dot thread-sidebar__status-dot--waiting" />
                      </Show>
                      <Show when={thread.status === "error"}>
                        <span class="thread-sidebar__status-dot thread-sidebar__status-dot--error" />
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            )}
          </For>
        </Show>
      </div>

      {/* Running agents count */}
      <Show when={threadStore.runningCount > 0}>
        <div class="thread-sidebar__footer">
          <span class="thread-sidebar__running-badge">
            {threadStore.runningCount} agent
            {threadStore.runningCount > 1 ? "s" : ""} running
          </span>
        </div>
      </Show>
    </aside>
  );
};
