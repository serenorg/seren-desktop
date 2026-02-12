// ABOUTME: Left sidebar with project header and unified thread list.
// ABOUTME: Displays all chat and agent threads for the active project, sorted by recency.

import { open } from "@tauri-apps/plugin-dialog";
import {
  type Component,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { fileTreeState, setRootPath } from "@/stores/fileTree";
import { type Thread, threadStore } from "@/stores/thread.store";

interface ThreadSidebarProps {
  collapsed: boolean;
  onToggle?: () => void;
}

export const ThreadSidebar: Component<ThreadSidebarProps> = (props) => {
  const [showNewMenu, setShowNewMenu] = createSignal(false);
  const [collapsedGroups, setCollapsedGroups] = createSignal<
    Set<string | null>
  >(new Set());
  let menuRef: HTMLDivElement | undefined;

  const folderName = () => {
    const root = fileTreeState.rootPath;
    if (!root) return null;
    return root.split("/").pop() || root;
  };

  const handleClickOutside = (e: MouseEvent) => {
    if (showNewMenu() && menuRef && !menuRef.contains(e.target as Node)) {
      setShowNewMenu(false);
    }
  };

  onMount(() => {
    document.addEventListener("mousedown", handleClickOutside);
  });

  onCleanup(() => {
    document.removeEventListener("mousedown", handleClickOutside);
  });

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

  const toggleGroup = (projectRoot: string | null) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(projectRoot)) {
        next.delete(projectRoot);
      } else {
        next.add(projectRoot);
      }
      return next;
    });
  };

  const isGroupCollapsed = (projectRoot: string | null) =>
    collapsedGroups().has(projectRoot);

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

  const FolderIcon: Component<{ size?: number }> = (iconProps) => (
    <svg
      width={iconProps.size ?? 14}
      height={iconProps.size ?? 14}
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
  );

  return (
    <aside
      class="flex flex-col bg-card border-r border-border overflow-hidden transition-all duration-200"
      classList={{
        "w-[var(--sidebar-width)] min-w-[var(--sidebar-width)]":
          !props.collapsed,
        "w-0 min-w-0 opacity-0 border-r-0": props.collapsed,
      }}
    >
      {/* Project header */}
      <div class="flex items-center justify-between px-3 py-2.5 border-b border-border shrink-0">
        <Show
          when={folderName()}
          fallback={
            <button
              type="button"
              class="flex items-center gap-1.5 flex-1 bg-transparent border border-dashed border-border text-muted-foreground text-xs cursor-pointer py-1.5 px-2.5 rounded-md transition-all duration-100 hover:border-primary hover:text-primary hover:bg-[rgba(56,189,248,0.08)]"
              onClick={handleOpenFolder}
            >
              <FolderIcon />
              Open Folder
            </button>
          }
        >
          <div class="flex items-center gap-1.5 flex-1 min-w-0">
            <button
              type="button"
              class="flex items-center gap-1.5 bg-transparent border-none text-foreground text-[13px] font-medium cursor-pointer py-1 px-2 rounded-md transition-colors duration-100 overflow-hidden text-ellipsis whitespace-nowrap hover:bg-surface-2"
              onClick={handleOpenFolder}
              title={fileTreeState.rootPath || ""}
            >
              <FolderIcon size={12} />
              {folderName()}
            </button>
          </div>
        </Show>

        <Show when={props.onToggle}>
          <button
            type="button"
            class="flex items-center justify-center w-[26px] h-[26px] bg-transparent border-none rounded-md text-muted-foreground cursor-pointer shrink-0 transition-all duration-100 hover:bg-surface-2 hover:text-foreground"
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
        </Show>
      </div>

      {/* New thread button */}
      <div class="px-3 py-2 relative shrink-0" ref={menuRef}>
        <button
          type="button"
          class="flex items-center gap-2 w-full py-2 px-3 bg-primary/8 border border-primary/15 rounded-lg text-primary text-[13px] font-medium cursor-pointer transition-all duration-150 hover:bg-primary/15 hover:border-primary/25 hover:shadow-[0_0_12px_rgba(56,189,248,0.1)] active:scale-[0.98]"
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
          <div class="absolute top-[calc(100%-4px)] left-3 right-3 bg-surface-2 border border-border rounded-lg p-1 z-20 shadow-md animate-[slideDown_150ms_ease]">
            <button
              type="button"
              class="flex items-center gap-2 w-full py-2 px-2.5 bg-transparent border-none rounded-md text-foreground text-[13px] cursor-pointer transition-colors duration-100 hover:bg-surface-3"
              onClick={handleNewChat}
            >
              <span class="text-sm w-5 text-center">{"\u{1F4AC}"}</span>
              Chat
            </button>
            <button
              type="button"
              class="flex items-center gap-2 w-full py-2 px-2.5 bg-transparent border-none rounded-md text-foreground text-[13px] cursor-pointer transition-colors duration-100 hover:bg-surface-3 disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => handleNewAgent("claude-code")}
              disabled={!fileTreeState.rootPath}
            >
              <span class="text-sm w-5 text-center">{"\u{1F916}"}</span>
              Claude Agent
            </button>
            <button
              type="button"
              class="flex items-center gap-2 w-full py-2 px-2.5 bg-transparent border-none rounded-md text-foreground text-[13px] cursor-pointer transition-colors duration-100 hover:bg-surface-3 disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => handleNewAgent("codex")}
              disabled={!fileTreeState.rootPath}
            >
              <span class="text-sm w-5 text-center">{"\u26A1"}</span>
              Codex Agent
            </button>
          </div>
        </Show>
      </div>

      {/* Thread list grouped by project */}
      <div class="flex-1 overflow-y-auto px-2 py-1">
        <Show
          when={threadStore.groupedThreads.length > 0}
          fallback={
            <div class="flex items-center justify-center px-4 py-8 text-muted-foreground text-[13px] opacity-60">
              <p class="m-0">No threads yet</p>
            </div>
          }
        >
          <For each={threadStore.groupedThreads}>
            {(group) => (
              <div class="mb-1">
                <Show when={threadStore.groupedThreads.length > 1}>
                  <button
                    type="button"
                    class="flex items-center gap-1.5 w-full px-2.5 py-1.5 mb-0.5 bg-transparent border-none text-[11px] font-semibold uppercase tracking-[0.04em] select-none cursor-pointer rounded-md transition-colors duration-100 hover:bg-surface-2"
                    classList={{
                      "text-primary":
                        group.projectRoot === fileTreeState.rootPath,
                      "text-muted-foreground":
                        group.projectRoot !== fileTreeState.rootPath,
                    }}
                    title={group.projectRoot || undefined}
                    onClick={() => toggleGroup(group.projectRoot)}
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 16 16"
                      fill="none"
                      role="img"
                      aria-label="Toggle"
                      class="shrink-0 transition-transform duration-150"
                      classList={{
                        "rotate-0": !isGroupCollapsed(group.projectRoot),
                        "-rotate-90": isGroupCollapsed(group.projectRoot),
                      }}
                    >
                      <path
                        d="M4 6l4 4 4-4"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                    <FolderIcon size={11} />
                    <span class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left">
                      {group.folderName}
                    </span>
                    <span class="text-[10px] font-medium text-muted-foreground opacity-60">
                      {group.threads.length}
                    </span>
                  </button>
                </Show>

                <Show when={!isGroupCollapsed(group.projectRoot)}>
                  <For each={group.threads}>
                    {(thread) => (
                      <button
                        type="button"
                        class="flex items-center gap-2 w-full py-2 px-2.5 bg-transparent border-none border-l-2 border-l-transparent rounded-lg cursor-pointer mb-0.5 text-left transition-all duration-150 hover:bg-surface-2/60"
                        classList={{
                          "!bg-surface-2/80 border-l-2 !border-l-primary !pl-2":
                            thread.id === threadStore.activeThreadId,
                        }}
                        onClick={() => handleSelectThread(thread)}
                      >
                        <div class="shrink-0 w-5 flex items-center justify-center">
                          <Show
                            when={thread.kind === "agent"}
                            fallback={
                              <span class="text-xs">{"\u{1F4AC}"}</span>
                            }
                          >
                            <span class="text-xs">
                              {thread.agentType === "codex"
                                ? "\u26A1"
                                : "\u{1F916}"}
                            </span>
                          </Show>
                        </div>

                        <span class="flex-1 min-w-0 text-[13px] text-foreground whitespace-nowrap overflow-hidden text-ellipsis">
                          {thread.title}
                        </span>
                        <span class="text-[11px] text-muted-foreground shrink-0">
                          {formatTime(thread.timestamp)}
                        </span>

                        <Show when={thread.status === "running"}>
                          <span class="w-2 h-2 rounded-full shrink-0 bg-status-running shadow-[0_0_6px_var(--status-running)] animate-pulse" />
                        </Show>
                        <Show when={thread.status === "waiting-input"}>
                          <span class="w-2 h-2 rounded-full shrink-0 bg-status-waiting shadow-[0_0_6px_var(--status-waiting)] animate-pulse" />
                        </Show>
                        <Show when={thread.status === "error"}>
                          <span class="w-2 h-2 rounded-full shrink-0 bg-status-error" />
                        </Show>
                      </button>
                    )}
                  </For>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>

      {/* Running agents footer */}
      <Show when={threadStore.runningCount > 0}>
        <div class="px-3 py-2 border-t border-border shrink-0 bg-surface-0/50">
          <span class="text-[11px] text-status-running flex items-center gap-1.5">
            <span class="w-1.5 h-1.5 rounded-full bg-status-running animate-pulse" />
            {threadStore.runningCount} agent
            {threadStore.runningCount > 1 ? "s" : ""} running
          </span>
        </div>
      </Show>
    </aside>
  );
};
