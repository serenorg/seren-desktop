// ABOUTME: Routes to the correct content view based on the active thread type.
// ABOUTME: Shows ChatContent for chat threads, AgentChat for agent threads, or empty state.

import { type Component, createMemo, For, Show } from "solid-js";
import { AgentChat } from "@/components/chat/AgentChat";
import { ChatContent } from "@/components/chat/ChatContent";
import { TerminalBuffer } from "@/components/terminal/TerminalBuffer";
import { openFolder } from "@/lib/files/service";
import { fileTreeState } from "@/stores/fileTree";
import { type WorkspaceWindow, workspaceStore } from "@/stores/workspace.store";

interface ThreadContentProps {
  onSignInClick: () => void;
}

export const ThreadContent: Component<ThreadContentProps> = (props) => {
  const activeWindow = () => workspaceStore.activeWindow;
  const mountedWindows = createMemo(() => {
    const byThreadId = new Map<string, WorkspaceWindow>();
    for (const workspace of workspaceStore.workspaces) {
      for (const workspaceWindow of workspace.windows) {
        if (!byThreadId.has(workspaceWindow.threadId)) {
          byThreadId.set(workspaceWindow.threadId, workspaceWindow);
        }
      }
    }
    return [...byThreadId.values()];
  });
  const paneClass = (workspaceWindow: WorkspaceWindow) =>
    workspaceWindow.threadId === activeWindow()?.threadId
      ? "absolute inset-0 flex flex-col min-h-0 h-full w-full"
      : "absolute inset-0 flex flex-col min-h-0 h-full w-full invisible pointer-events-none";

  return (
    <div
      id="workspace-content-panel"
      role="tabpanel"
      class="relative flex flex-col h-full overflow-hidden"
    >
      <div class="relative flex-1 overflow-hidden min-h-0">
        <For each={mountedWindows()}>
          {(workspaceWindow) => (
            <div
              class={paneClass(workspaceWindow)}
              aria-hidden={
                workspaceWindow.threadId !== activeWindow()?.threadId
              }
            >
              <Show when={workspaceWindow.kind === "chat"}>
                <ChatContent
                  threadId={workspaceWindow.threadId}
                  active={workspaceWindow.threadId === activeWindow()?.threadId}
                  onSignInClick={props.onSignInClick}
                />
              </Show>
              <Show when={workspaceWindow.kind === "agent"}>
                <AgentChat
                  threadId={workspaceWindow.threadId}
                  active={workspaceWindow.threadId === activeWindow()?.threadId}
                />
              </Show>
              <Show when={workspaceWindow.kind === "terminal"}>
                <TerminalBuffer threadId={workspaceWindow.threadId} />
              </Show>
            </div>
          )}
        </For>
        <Show when={!activeWindow()}>
          <EmptyState />
        </Show>
      </div>
    </div>
  );
};

function EmptyState() {
  const handleOpenFolder = async () => {
    await openFolder();
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
