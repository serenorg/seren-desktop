// ABOUTME: Horizontal tab bar for switching between chat and agent threads.
// ABOUTME: Shows thread tabs with icons, titles, status dots, close buttons, and a "+ New" dropdown.

import {
  type Component,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { fileTreeState } from "@/stores/fileTree";
import { type Thread, threadStore } from "@/stores/thread.store";

export const ThreadTabBar: Component = () => {
  const [showNewMenu, setShowNewMenu] = createSignal(false);
  let menuRef: HTMLDivElement | undefined;

  // Close dropdown on click-outside
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
    <div class="flex items-stretch h-9 bg-surface-1 border-b border-border shrink-0">
      <div
        class="flex items-stretch flex-1 min-w-0 overflow-x-auto scrollbar-thin"
        role="tablist"
      >
        <For each={threadStore.threads}>
          {(thread) => (
            <button
              type="button"
              role="tab"
              class="group flex items-center gap-1.5 px-3 min-w-0 max-w-[180px] bg-none border-none border-b-2 border-b-transparent text-muted-foreground text-[13px] cursor-pointer whitespace-nowrap transition-all duration-100 relative hover:bg-[rgba(148,163,184,0.06)] hover:text-foreground"
              classList={{
                "!text-foreground !border-b-primary !bg-[rgba(148,163,184,0.04)]":
                  thread.id === threadStore.activeThreadId,
              }}
              aria-selected={thread.id === threadStore.activeThreadId}
              onClick={() => handleSelect(thread)}
              title={thread.title}
            >
              <span class="text-[13px] shrink-0">{threadIcon(thread)}</span>
              <span class="overflow-hidden text-ellipsis min-w-0">
                {thread.title}
              </span>
              <Show when={thread.status === "running"}>
                <span class="w-1.5 h-1.5 rounded-full shrink-0 bg-success shadow-[0_0_4px_var(--color-success)] animate-[tabPulse_2s_ease-in-out_infinite]" />
              </Show>
              <Show when={thread.status === "waiting-input"}>
                <span class="w-1.5 h-1.5 rounded-full shrink-0 bg-warning shadow-[0_0_4px_var(--color-warning)] animate-[tabPulse_1.5s_ease-in-out_infinite]" />
              </Show>
              <Show when={thread.status === "error"}>
                <span class="w-1.5 h-1.5 rounded-full shrink-0 bg-destructive" />
              </Show>
              <span
                role="button"
                tabindex={0}
                class="hidden group-hover:flex items-center justify-center w-4 h-4 bg-none border-none rounded-sm text-muted-foreground cursor-pointer text-sm leading-none p-0 shrink-0 transition-all duration-100 hover:bg-[rgba(148,163,184,0.15)] hover:text-foreground"
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
      <div class="relative shrink-0" ref={menuRef}>
        <button
          type="button"
          class="flex items-center justify-center w-8 h-full bg-none border-none border-l border-l-border text-muted-foreground cursor-pointer transition-all duration-100 hover:bg-[rgba(148,163,184,0.08)] hover:text-primary"
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
          <div class="absolute top-full right-0 min-w-[160px] bg-surface-2 border border-border rounded-lg p-1 z-20 shadow-[var(--shadow-lg)] animate-[slideInDown_150ms_ease]">
            <button
              type="button"
              class="flex items-center gap-2 w-full py-[7px] px-2.5 bg-none border-none rounded-md text-foreground text-[13px] cursor-pointer transition-colors duration-100 hover:enabled:bg-[rgba(148,163,184,0.08)] disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={handleNewChat}
            >
              <span class="text-[13px] w-[18px] text-center">💬</span>
              Chat
            </button>
            <button
              type="button"
              class="flex items-center gap-2 w-full py-[7px] px-2.5 bg-none border-none rounded-md text-foreground text-[13px] cursor-pointer transition-colors duration-100 hover:enabled:bg-[rgba(148,163,184,0.08)] disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => handleNewAgent("claude-code")}
              disabled={!fileTreeState.rootPath}
              title={
                !fileTreeState.rootPath
                  ? "Open a folder first to use agents"
                  : undefined
              }
            >
              <span class="text-[13px] w-[18px] text-center">🤖</span>
              Claude Agent
            </button>
            <button
              type="button"
              class="flex items-center gap-2 w-full py-[7px] px-2.5 bg-none border-none rounded-md text-foreground text-[13px] cursor-pointer transition-colors duration-100 hover:enabled:bg-[rgba(148,163,184,0.08)] disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => handleNewAgent("codex")}
              disabled={!fileTreeState.rootPath}
              title={
                !fileTreeState.rootPath
                  ? "Open a folder first to use agents"
                  : undefined
              }
            >
              <span class="text-[13px] w-[18px] text-center">⚡</span>
              Codex Agent
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
};
