// ABOUTME: Left sidebar with project header and unified thread list.
// ABOUTME: Displays all chat and agent threads for the active project, sorted by recency.

import {
  type Component,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { CreateEmployeeModal } from "@/components/sidebar/CreateEmployeeModal";
import {
  type EmployeeDetailEventDetail,
  EmployeesSection,
  OPEN_EMPLOYEE_DETAIL_EVENT,
} from "@/components/sidebar/EmployeesSection";
import { openFolder } from "@/lib/files/service";
import {
  encodeThreadDragPayload,
  encodeThreadDragText,
  setCurrentThreadDragPayload,
  THREAD_DRAG_MIME,
} from "@/lib/thread-drag";
import {
  allowsClaudeAgent,
  allowsCodexAgent,
  allowsGeminiAgent,
  allowsSerenPrivateAgent,
  allowsSerenPublicModels,
} from "@/services/organization-policy";
import { agentStore } from "@/stores/agent.store";
import { authStore } from "@/stores/auth.store";
import { editorSessionStore } from "@/stores/editor.sessions";
import { fileTreeState } from "@/stores/fileTree";
import { type Thread, threadStore } from "@/stores/thread.store";
import { type WorkspaceWindow, workspaceStore } from "@/stores/workspace.store";

interface ThreadSidebarProps {
  collapsed: boolean;
  onToggle?: () => void;
}

const PROJECT_GROUP_DRAG_MIME = "application/x-seren-project-group";

interface ProjectDropTarget {
  projectRoot: string;
  position: "before" | "after";
}

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

const TerminalIcon: Component<{ size?: number; strokeWidth?: number }> = (
  iconProps,
) => (
  <svg
    width={iconProps.size ?? 14}
    height={iconProps.size ?? 14}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width={iconProps.strokeWidth ?? 1.3}
    stroke-linecap="round"
    stroke-linejoin="round"
    role="img"
    aria-label="Terminal"
  >
    <path d="M2.5 3.5h11v9h-11z" />
    <path d="M5 6l2 2-2 2" />
    <path d="M8.5 10h3" />
  </svg>
);

const EditorIcon: Component<{ size?: number; strokeWidth?: number }> = (
  iconProps,
) => (
  <svg
    width={iconProps.size ?? 14}
    height={iconProps.size ?? 14}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width={iconProps.strokeWidth ?? 1.3}
    stroke-linecap="round"
    stroke-linejoin="round"
    role="img"
    aria-label="Editor"
  >
    <path d="M9.5 2.5H4a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 4 13.5h8A1.5 1.5 0 0 0 13.5 12V6" />
    <path d="M11 2.5l2.5 2.5-5.5 5.5H5.5V8L11 2.5z" />
  </svg>
);

export const ThreadSidebar: Component<ThreadSidebarProps> = (props) => {
  const [showLauncher, setShowLauncher] = createSignal(false);
  const [showCreateEmployee, setShowCreateEmployee] = createSignal(false);
  const [collapsedGroups, setCollapsedGroups] = createSignal<
    Set<string | null>
  >(new Set());
  const [spawning, setSpawning] = createSignal(false);
  let launcherRef: HTMLDivElement | undefined;

  const folderName = () => {
    const root = fileTreeState.rootPath;
    if (!root) return null;
    return root.split("/").pop() || root;
  };
  const primaryChatLauncherDescription = createMemo(() => "Seren models chat");

  const handleClickOutside = (e: MouseEvent) => {
    const target = e.target as Node;
    if (showLauncher() && launcherRef && !launcherRef.contains(target)) {
      setShowLauncher(false);
    }
  };

  const handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && showLauncher()) {
      event.preventDefault();
      setShowLauncher(false);
    }
  };

  onMount(() => {
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleDocumentKeydown);
  });

  onCleanup(() => {
    document.removeEventListener("mousedown", handleClickOutside);
    document.removeEventListener("keydown", handleDocumentKeydown);
  });

  const handleOpenFolder = async () => {
    await openFolder();
  };

  const handleNewChat = async () => {
    setShowLauncher(false);
    setSpawning(true);
    try {
      await threadStore.createChatThreadWithOptions("New Chat", {
        provider: "seren",
      });
    } finally {
      setSpawning(false);
    }
  };

  const handleNewPrivateChat = async () => {
    setShowLauncher(false);
    setSpawning(true);
    try {
      const privateModel =
        authStore.privateChatPolicy?.model_id?.trim() ||
        "organization/private-model";
      await threadStore.createChatThreadWithOptions("New Private Chat", {
        provider: "seren-private",
        model: privateModel,
      });
    } finally {
      setSpawning(false);
    }
  };

  const handleNewTerminal = async (options?: {
    title?: string;
    command?: string;
  }) => {
    setShowLauncher(false);
    setSpawning(true);
    try {
      await threadStore.createTerminalThread(options);
    } finally {
      setSpawning(false);
    }
  };

  const handleNewEmployee = () => {
    setShowLauncher(false);
    setShowCreateEmployee(true);
  };

  const handleEmployeeCreated = (employeeId: string) => {
    window.dispatchEvent(
      new CustomEvent<EmployeeDetailEventDetail>(OPEN_EMPLOYEE_DETAIL_EVENT, {
        detail: { employeeId },
      }),
    );
  };

  const handleNewAgent = async (
    agentType: "claude-code" | "codex" | "gemini",
  ) => {
    setShowLauncher(false);
    const cwd = fileTreeState.rootPath;
    if (!cwd) return;
    setSpawning(true);
    try {
      await threadStore.createAgentThread(agentType, cwd);
    } finally {
      setSpawning(false);
    }
  };

  const toggleLauncher = () => {
    setShowLauncher((v) => !v);
  };

  const handleSelectThread = (thread: Thread) => {
    threadStore.selectThread(thread.id, thread.kind);
  };

  const handleThreadDragStart = (event: DragEvent, thread: Thread) => {
    const payload = { id: thread.id, kind: thread.kind };
    setCurrentThreadDragPayload(payload);
    event.dataTransfer?.setData(
      THREAD_DRAG_MIME,
      encodeThreadDragPayload(payload),
    );
    event.dataTransfer?.setData("text/plain", encodeThreadDragText(payload));
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "copy";
    }
  };

  const handleThreadDragEnd = () => {
    setCurrentThreadDragPayload(null);
  };

  const [draggingProjectRoot, setDraggingProjectRoot] = createSignal<
    string | null
  >(null);
  const [projectDropTarget, setProjectDropTarget] =
    createSignal<ProjectDropTarget | null>(null);

  const handleProjectDragStart = (event: DragEvent, projectRoot: string) => {
    setDraggingProjectRoot(projectRoot);
    event.dataTransfer?.setData(PROJECT_GROUP_DRAG_MIME, projectRoot);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
  };

  const handleProjectDragEnd = () => {
    setDraggingProjectRoot(null);
    setProjectDropTarget(null);
  };

  const handleProjectDragOver = (event: DragEvent, projectRoot: string) => {
    const source = draggingProjectRoot();
    if (!source) return;
    // preventDefault + dropEffect=move on every dragover keeps the cursor
    // showing "move" (no "+") even when hovering the source itself.
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    if (source === projectRoot) {
      if (projectDropTarget() !== null) setProjectDropTarget(null);
      return;
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const position: "before" | "after" =
      event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    const current = projectDropTarget();
    if (
      !current ||
      current.projectRoot !== projectRoot ||
      current.position !== position
    ) {
      setProjectDropTarget({ projectRoot, position });
    }
  };

  const handleProjectDrop = (event: DragEvent, targetRoot: string) => {
    const source =
      event.dataTransfer?.getData(PROJECT_GROUP_DRAG_MIME) ||
      draggingProjectRoot();
    const target = projectDropTarget();
    setDraggingProjectRoot(null);
    setProjectDropTarget(null);
    if (!source || source === targetRoot) return;
    event.preventDefault();
    const position =
      target?.projectRoot === targetRoot ? target.position : "after";
    threadStore.reorderProjectGroup(source, targetRoot, position);
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

  // Right-aligned chip telling the user *what surface / how it's billed*.
  const LauncherChip: Component<{
    variant: "paid" | "subscription" | "cli";
    children: string;
  }> = (chipProps) => {
    const tone = () =>
      chipProps.variant === "paid"
        ? "bg-primary/10 text-primary/90 border-primary/25"
        : chipProps.variant === "subscription"
          ? "bg-purple-500/12 text-purple-300 border-purple-500/30"
          : "bg-surface-3 text-muted-foreground border-border";
    return (
      <span
        class={`text-[10px] font-semibold tracking-[0.04em] px-1.5 py-0.5 rounded-full border whitespace-nowrap ${tone()}`}
      >
        {chipProps.children}
      </span>
    );
  };

  // Frames a brand emoji as a CLI command — small bordered square with a
  // `>_` corner badge — so CLI rows visually depart from chat-style agent rows.
  const CliBrandIcon: Component<{ glyph: string }> = (iconProps) => (
    <span class="relative inline-flex items-center justify-center w-[22px] h-[22px] rounded-[5px] border border-border bg-black/25 text-[12px] shrink-0">
      <span aria-hidden="true">{iconProps.glyph}</span>
      <span
        aria-hidden="true"
        class="absolute -bottom-1 -right-1.5 px-[3px] py-[1px] rounded-[3px] border border-border bg-surface-2 text-[8px] font-semibold leading-none text-muted-foreground font-mono"
      >
        &gt;_
      </span>
    </span>
  );

  const SectionLabel: Component<{ children: string }> = (labelProps) => (
    <div class="px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 select-none">
      {labelProps.children}
    </div>
  );

  const SectionDivider: Component = () => (
    <div class="h-px bg-border/60 mx-3 my-1" />
  );

  const claudeAvailable = createMemo(() =>
    agentStore.availableAgents.some(
      (a) => a.type === "claude-code" && a.available,
    ),
  );
  const codexAvailable = createMemo(() =>
    agentStore.availableAgents.some((a) => a.type === "codex" && a.available),
  );
  const geminiAvailable = createMemo(() =>
    agentStore.availableAgents.some((a) => a.type === "gemini" && a.available),
  );
  const showSerenChat = createMemo(() =>
    allowsSerenPublicModels(authStore.privateChatPolicy),
  );
  const showSerenPrivate = createMemo(() =>
    allowsSerenPrivateAgent(authStore.privateChatPolicy),
  );
  const showClaudeAgent = createMemo(
    () => allowsClaudeAgent(authStore.privateChatPolicy) && claudeAvailable(),
  );
  const showCodexAgent = createMemo(
    () => allowsCodexAgent(authStore.privateChatPolicy) && codexAvailable(),
  );
  const showGeminiAgent = createMemo(
    () => allowsGeminiAgent(authStore.privateChatPolicy) && geminiAvailable(),
  );
  const hasChatSection = createMemo(
    () => showSerenChat() || showSerenPrivate(),
  );
  const hasAgentSection = createMemo(
    () => showClaudeAgent() || showCodexAgent() || showGeminiAgent(),
  );
  const hasCliSection = createMemo(() => claudeAvailable() || codexAvailable());

  return (
    <aside
      data-testid="thread-sidebar"
      class="flex flex-col bg-card border-r border-border overflow-hidden transition-[width] duration-200"
      classList={{
        "w-[var(--sidebar-width)] min-w-[var(--sidebar-width)]":
          !props.collapsed,
        // Collapsed: a 36px rail keeps the toggle button reachable.
        "w-9 min-w-9": props.collapsed,
      }}
      onDragEnter={(event) => {
        if (!draggingProjectRoot()) return;
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = "move";
        }
      }}
      onDragOver={(event) => {
        // Anchor the move cursor anywhere within the sidebar while a project
        // group is being dragged so brief excursions outside the thread list
        // don't flip the platform cursor back to copy ("+").
        if (!draggingProjectRoot()) return;
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = "move";
        }
      }}
    >
      <Show when={props.collapsed && props.onToggle}>
        <div class="flex flex-col items-center pt-2 shrink-0 gap-1">
          <button
            type="button"
            class="flex items-center justify-center w-7 h-7 bg-transparent border-none rounded-md text-muted-foreground cursor-pointer transition-all duration-100 hover:bg-surface-2 hover:text-foreground"
            onClick={props.onToggle}
            title="Show sidebar"
            aria-label="Show sidebar"
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

          <CollapsedPaneList />
        </div>
      </Show>

      <Show when={!props.collapsed}>
        {/* Project header */}
        <div class="flex items-center justify-between px-3 py-2.5 border-b border-border shrink-0">
          <Show
            when={folderName()}
            fallback={
              <button
                type="button"
                class="flex items-center gap-1.5 flex-1 bg-transparent border border-dashed border-border text-muted-foreground text-xs cursor-pointer py-1.5 px-2.5 rounded-md transition-all duration-100 hover:border-primary hover:text-primary hover:bg-primary/[0.08]"
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
        <div class="px-3 py-2 shrink-0 relative" ref={launcherRef}>
          <button
            type="button"
            data-testid="new-thread-button"
            class="flex items-center gap-2 w-full py-2 px-3 bg-primary/8 border border-primary/15 rounded-lg text-primary text-[13px] font-medium cursor-pointer transition-all duration-150 hover:bg-primary/15 hover:border-primary/25 hover:shadow-[0_0_12px_rgba(56,189,248,0.1)] active:scale-[0.98] disabled:opacity-60 disabled:cursor-wait disabled:hover:bg-primary/8"
            onClick={toggleLauncher}
            disabled={spawning()}
            aria-haspopup="menu"
            aria-expanded={showLauncher()}
          >
            <Show
              when={!spawning()}
              fallback={
                <span class="w-3.5 h-3.5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              }
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
            </Show>
            {spawning() ? (agentStore.installStatus ?? "Starting...") : "New"}
          </button>

          <Show when={showLauncher()}>
            <div class="absolute top-[calc(100%+4px)] left-3 right-3 max-h-[60vh] overflow-y-auto bg-surface-2 border border-border rounded-lg z-20 shadow-lg animate-[slideDown_150ms_ease] py-1">
              {/* ---------- Chat ---------- */}
              <Show when={hasChatSection()}>
                <SectionLabel>Chat</SectionLabel>
              </Show>
              <Show when={showSerenChat()}>
                <button
                  type="button"
                  data-testid="new-seren-chat"
                  class="flex items-center gap-2.5 w-full py-2 px-3 bg-transparent border-none rounded-md text-foreground text-[13px] cursor-pointer transition-colors duration-100 hover:bg-surface-3 text-left"
                  onClick={handleNewChat}
                >
                  <span class="text-[14px] w-[22px] text-center shrink-0">
                    {"\u{1F4AC}"}
                  </span>
                  <div class="flex-1 min-w-0">
                    <div class="font-medium">Seren Agent</div>
                    <div class="text-[11px] text-muted-foreground">
                      {primaryChatLauncherDescription()}
                    </div>
                  </div>
                  <LauncherChip variant="paid">Pay-as-you-go</LauncherChip>
                </button>
              </Show>
              <Show when={showSerenPrivate()}>
                <button
                  type="button"
                  data-testid="new-seren-private-agent"
                  class="flex items-center gap-2.5 w-full py-2 px-3 bg-transparent border-none rounded-md text-foreground text-[13px] cursor-pointer transition-colors duration-100 hover:bg-surface-3 text-left"
                  onClick={handleNewPrivateChat}
                >
                  <span class="text-[14px] w-[22px] text-center shrink-0">
                    {"\u{1F512}"}
                  </span>
                  <div class="flex-1 min-w-0">
                    <div class="font-medium">Seren Agent (Private)</div>
                    <div class="text-[11px] text-muted-foreground">
                      Private SerenModels · AWS Bedrock &amp; Azure
                    </div>
                  </div>
                  <LauncherChip variant="paid">Pay-as-you-go</LauncherChip>
                </button>
              </Show>

              {/* ---------- Coding agents ---------- */}
              <Show when={hasAgentSection() && hasChatSection()}>
                <SectionDivider />
              </Show>
              <Show when={hasAgentSection()}>
                <SectionLabel>Coding agents</SectionLabel>
              </Show>
              <Show when={showClaudeAgent()}>
                <button
                  type="button"
                  data-testid="new-claude-agent"
                  class="flex items-center gap-2.5 w-full py-2 px-3 bg-transparent border-none rounded-md text-foreground text-[13px] cursor-pointer transition-colors duration-100 hover:bg-surface-3 text-left"
                  onClick={() => void handleNewAgent("claude-code")}
                >
                  <span class="text-[14px] w-[22px] text-center shrink-0">
                    {"\u{1F916}"}
                  </span>
                  <div class="flex-1 min-w-0">
                    <div class="font-medium">Claude Code</div>
                    <div class="text-[11px] text-muted-foreground">
                      Anthropic · chat-style coding agent
                    </div>
                  </div>
                  <LauncherChip variant="subscription">
                    Subscription
                  </LauncherChip>
                </button>
              </Show>
              <Show when={showCodexAgent()}>
                <button
                  type="button"
                  data-testid="new-codex-agent"
                  class="flex items-center gap-2.5 w-full py-2 px-3 bg-transparent border-none rounded-md text-foreground text-[13px] cursor-pointer transition-colors duration-100 hover:bg-surface-3 text-left"
                  onClick={() => void handleNewAgent("codex")}
                >
                  <span class="text-[14px] w-[22px] text-center shrink-0">
                    {"\u26A1"}
                  </span>
                  <div class="flex-1 min-w-0">
                    <div class="font-medium">Codex</div>
                    <div class="text-[11px] text-muted-foreground">
                      OpenAI · chat-style coding agent
                    </div>
                  </div>
                  <LauncherChip variant="subscription">
                    Subscription
                  </LauncherChip>
                </button>
              </Show>
              <Show when={showGeminiAgent()}>
                <button
                  type="button"
                  data-testid="new-gemini-agent"
                  class="flex items-center gap-2.5 w-full py-2 px-3 bg-transparent border-none rounded-md text-foreground text-[13px] cursor-pointer transition-colors duration-100 hover:bg-surface-3 text-left"
                  onClick={() => void handleNewAgent("gemini")}
                >
                  <span class="text-[14px] w-[22px] text-center shrink-0">
                    {"\u2728"}
                  </span>
                  <div class="flex-1 min-w-0">
                    <div class="font-medium">Gemini</div>
                    <div class="text-[11px] text-muted-foreground">
                      Google · chat-style coding agent
                    </div>
                  </div>
                  <LauncherChip variant="subscription">
                    Subscription
                  </LauncherChip>
                </button>
              </Show>

              {/* ---------- Command line ---------- */}
              <Show
                when={
                  hasCliSection() && (hasChatSection() || hasAgentSection())
                }
              >
                <SectionDivider />
              </Show>
              <Show when={hasCliSection()}>
                <SectionLabel>Command line</SectionLabel>
              </Show>
              <Show when={claudeAvailable()}>
                <button
                  type="button"
                  data-testid="new-claude-cli"
                  class="flex items-center gap-2.5 w-full py-2 px-3 bg-transparent border-none rounded-md text-foreground text-[13px] cursor-pointer transition-colors duration-100 hover:bg-surface-3 text-left"
                  onClick={() =>
                    void handleNewTerminal({
                      title: "Claude Code CLI",
                      command: "claude",
                    })
                  }
                >
                  <CliBrandIcon glyph={"\u{1F916}"} />
                  <div class="flex-1 min-w-0">
                    <div class="font-medium">Claude Code</div>
                    <div class="text-[11px] text-muted-foreground">
                      Runs <code class="font-mono text-[10px]">claude</code> in
                      a terminal pane
                    </div>
                  </div>
                  <LauncherChip variant="cli">CLI</LauncherChip>
                </button>
              </Show>
              <Show when={codexAvailable()}>
                <button
                  type="button"
                  data-testid="new-codex-cli"
                  class="flex items-center gap-2.5 w-full py-2 px-3 bg-transparent border-none rounded-md text-foreground text-[13px] cursor-pointer transition-colors duration-100 hover:bg-surface-3 text-left"
                  onClick={() =>
                    void handleNewTerminal({
                      title: "Codex CLI",
                      command: "codex",
                    })
                  }
                >
                  <CliBrandIcon glyph={"⚡"} />
                  <div class="flex-1 min-w-0">
                    <div class="font-medium">Codex</div>
                    <div class="text-[11px] text-muted-foreground">
                      Runs <code class="font-mono text-[10px]">codex</code> in a
                      terminal pane
                    </div>
                  </div>
                  <LauncherChip variant="cli">CLI</LauncherChip>
                </button>
              </Show>

              {/* ---------- Shell ---------- */}
              <SectionDivider />
              <SectionLabel>Shell</SectionLabel>
              <button
                type="button"
                data-testid="new-terminal"
                class="flex items-center gap-2.5 w-full py-2 px-3 bg-transparent border-none rounded-md text-foreground text-[13px] cursor-pointer transition-colors duration-100 hover:bg-surface-3 text-left"
                onClick={() => void handleNewTerminal({ title: "Terminal" })}
              >
                <span class="w-[22px] flex items-center justify-center shrink-0">
                  <TerminalIcon />
                </span>
                <div class="flex-1 min-w-0">
                  <div class="font-medium">Terminal</div>
                  <div class="text-[11px] text-muted-foreground">
                    Plain shell at project root
                  </div>
                </div>
              </button>
            </div>
          </Show>
        </div>

        {/* Thread list grouped by project */}
        <div
          class="flex-1 overflow-y-auto px-2 py-1"
          onDragOver={(event) => {
            // Keep cursor showing "move" anywhere within the thread list while
            // a project group is being dragged, including between/around the
            // group headers where per-button handlers don't fire.
            if (!draggingProjectRoot()) return;
            event.preventDefault();
            if (event.dataTransfer) {
              event.dataTransfer.dropEffect = "move";
            }
          }}
        >
          <EmployeesSection onCreateEmployee={handleNewEmployee} />
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
                    <Show
                      when={
                        projectDropTarget()?.projectRoot ===
                          group.projectRoot &&
                        projectDropTarget()?.position === "before"
                      }
                    >
                      <div class="h-0.5 mx-2 mb-0.5 bg-primary rounded-full" />
                    </Show>
                    <button
                      type="button"
                      class="flex items-center gap-1.5 w-full px-2.5 py-1.5 mb-0.5 bg-transparent border-none text-[11px] font-semibold uppercase tracking-[0.04em] select-none cursor-pointer rounded-md transition-colors duration-100 hover:bg-surface-2"
                      classList={{
                        "text-primary":
                          group.projectRoot === fileTreeState.rootPath,
                        "text-muted-foreground":
                          group.projectRoot !== fileTreeState.rootPath,
                        "opacity-50":
                          draggingProjectRoot() === group.projectRoot,
                      }}
                      title={group.projectRoot || undefined}
                      onClick={() => toggleGroup(group.projectRoot)}
                      draggable={group.projectRoot !== null}
                      onDragStart={(e) => {
                        if (group.projectRoot !== null) {
                          handleProjectDragStart(e, group.projectRoot);
                        }
                      }}
                      onDragEnd={handleProjectDragEnd}
                      onDragOver={(e) => {
                        if (group.projectRoot !== null) {
                          handleProjectDragOver(e, group.projectRoot);
                        }
                      }}
                      onDrop={(e) => {
                        if (group.projectRoot !== null) {
                          handleProjectDrop(e, group.projectRoot);
                        }
                      }}
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
                      <Show
                        when={group.threads.some((t) => t.status === "running")}
                      >
                        <span
                          class="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0"
                          title="Running agent"
                        />
                      </Show>
                      <span class="text-[10px] font-medium text-muted-foreground opacity-60">
                        {group.threads.length}
                      </span>
                    </button>
                  </Show>

                  <Show when={!isGroupCollapsed(group.projectRoot)}>
                    <For each={group.threads}>
                      {(thread) => (
                        <div
                          data-testid="thread-item"
                          data-thread-id={thread.id}
                          data-thread-kind={thread.kind}
                          draggable={true}
                          class="group flex items-center gap-2 w-full py-2 px-2.5 bg-transparent border-none border-l-2 border-l-transparent rounded-lg cursor-pointer mb-0.5 text-left transition-all duration-150 hover:bg-surface-2/60 active:cursor-grabbing"
                          classList={{
                            "!bg-surface-2/80 border-l-2 !border-l-primary !pl-2":
                              thread.id === threadStore.activeThreadId,
                          }}
                          onClick={() => handleSelectThread(thread)}
                          onDragStart={(e) => handleThreadDragStart(e, thread)}
                          onDragEnd={handleThreadDragEnd}
                        >
                          <div class="shrink-0 w-5 flex items-center justify-center">
                            <Show
                              when={thread.kind === "agent"}
                              fallback={
                                <Show
                                  when={thread.kind === "terminal"}
                                  fallback={
                                    <Show
                                      when={thread.kind === "editor"}
                                      fallback={
                                        <span class="text-xs">
                                          {"\u{1F4AC}"}
                                        </span>
                                      }
                                    >
                                      <EditorIcon size={13} strokeWidth={1.4} />
                                    </Show>
                                  }
                                >
                                  <TerminalIcon size={13} strokeWidth={1.4} />
                                </Show>
                              }
                            >
                              <span class="text-xs">
                                {thread.agentType === "codex"
                                  ? "\u26A1"
                                  : thread.agentType === "gemini"
                                    ? "\u2728"
                                    : "\u{1F916}"}
                              </span>
                            </Show>
                          </div>

                          <span class="flex-1 min-w-0 text-[13px] text-foreground whitespace-nowrap overflow-hidden text-ellipsis">
                            {thread.title}
                          </span>
                          <Show
                            when={thread.kind === "editor"}
                            fallback={
                              <span class="text-[11px] text-muted-foreground shrink-0">
                                {formatTime(thread.timestamp)}
                              </span>
                            }
                          >
                            <Show
                              when={
                                editorSessionStore.findById(thread.id)?.isDirty
                              }
                            >
                              <span
                                class="text-warning text-[11px] -mr-0.5"
                                title="Unsaved changes"
                              >
                                ●
                              </span>
                            </Show>
                          </Show>

                          <Show
                            when={
                              thread.kind === "agent" &&
                              thread.id !== threadStore.activeThreadId &&
                              agentStore.hasPendingApprovals(thread.id)
                            }
                          >
                            <span
                              class="permission-indicator"
                              title="Permission required"
                            />
                          </Show>
                          <Show
                            when={
                              !(
                                thread.kind === "agent" &&
                                thread.id !== threadStore.activeThreadId &&
                                agentStore.hasPendingApprovals(thread.id)
                              )
                            }
                          >
                            <Show when={thread.status === "running"}>
                              <span class="w-2 h-2 rounded-full shrink-0 bg-status-running shadow-[0_0_6px_var(--status-running)] animate-pulse" />
                            </Show>
                            <Show when={thread.status === "waiting-input"}>
                              <span class="w-2 h-2 rounded-full shrink-0 bg-status-waiting shadow-[0_0_6px_var(--status-waiting)] animate-pulse" />
                            </Show>
                            <Show when={thread.status === "error"}>
                              <span class="w-2 h-2 rounded-full shrink-0 bg-status-error" />
                            </Show>
                          </Show>

                          {/* Close button */}
                          <button
                            type="button"
                            class="opacity-0 group-hover:opacity-100 hover:!opacity-100 ml-1 shrink-0 w-4 h-4 flex items-center justify-center rounded hover:bg-surface-3 text-muted-foreground hover:text-foreground transition-all"
                            onClick={async (e) => {
                              e.stopPropagation();
                              await threadStore.archiveThread(
                                thread.id,
                                thread.kind,
                              );
                            }}
                            title="Close thread"
                          >
                            <svg
                              width="10"
                              height="10"
                              viewBox="0 0 16 16"
                              fill="none"
                              role="img"
                              aria-label="Close"
                            >
                              <path
                                d="M4 4l8 8M12 4l-8 8"
                                stroke="currentColor"
                                stroke-width="1.5"
                                stroke-linecap="round"
                              />
                            </svg>
                          </button>
                        </div>
                      )}
                    </For>
                  </Show>
                  <Show
                    when={
                      projectDropTarget()?.projectRoot === group.projectRoot &&
                      projectDropTarget()?.position === "after"
                    }
                  >
                    <div class="h-0.5 mx-2 mt-0.5 bg-primary rounded-full" />
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>

        {/* Session & running agents footer */}
        <div class="border-t border-border shrink-0 bg-surface-0/50">
          <button
            type="button"
            data-testid="sessions-button"
            class="w-full px-3 py-2 text-left text-[12px] text-muted-foreground hover:text-foreground hover:bg-surface-1/50 transition-colors flex items-center gap-2"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("seren:open-panel", { detail: "sessions" }),
              )
            }
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              role="img"
              aria-label="Sessions"
            >
              <rect
                x="2"
                y="3"
                width="12"
                height="10"
                rx="2"
                stroke="currentColor"
                stroke-width="1.2"
              />
              <path
                d="M5 7h6M5 9.5h4"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
              />
            </svg>
            Sessions
          </button>

          <Show when={threadStore.runningCount > 0}>
            <div class="px-3 py-2 border-t border-border/30">
              <span class="text-[11px] text-status-running flex items-center gap-1.5">
                <span class="w-1.5 h-1.5 rounded-full bg-status-running animate-pulse" />
                {threadStore.runningCount} agent
                {threadStore.runningCount > 1 ? "s" : ""} running
              </span>
            </div>
          </Show>
        </div>
        <Show when={showCreateEmployee()}>
          <CreateEmployeeModal
            onClose={() => setShowCreateEmployee(false)}
            onCreated={handleEmployeeCreated}
          />
        </Show>
      </Show>
    </aside>
  );
};

/**
 * Vertical strip of clickable pane icons rendered inside the collapsed
 * sidebar rail. One icon per workspace window in the active workspace,
 * letting the user jump between panes without expanding the sidebar.
 * Status dots match the existing thread-row indicators.
 */
const CollapsedPaneList: Component = () => {
  const panes = () =>
    workspaceStore.activeWorkspace.windows.filter((w) => w.kind !== null);

  const threadFor = (window: WorkspaceWindow): Thread | undefined => {
    if (window.threadId === null) {
      if (window.kind === "editor")
        return threadStore.threads.find((t) => t.kind === "editor");
      return undefined;
    }
    return threadStore.threads.find((t) => t.id === window.threadId);
  };

  const titleFor = (window: WorkspaceWindow): string => {
    const thread = threadFor(window);
    if (thread) return thread.title;
    if (window.kind === "editor") return "Editor";
    return "Pane";
  };

  const handleClick = (window: WorkspaceWindow) => {
    workspaceStore.focusWindow(window.id);
  };

  return (
    <Show when={panes().length > 0}>
      <div
        class="w-full mt-1 pt-1 border-t border-border/40 flex flex-col items-center gap-1"
        role="tablist"
        aria-label="Workspace panes"
      >
        <For each={panes()}>
          {(window) => {
            const isActive = () =>
              workspaceStore.activeWorkspace.focusedWindowId === window.id;
            const status = () => threadFor(window)?.status ?? "idle";
            return (
              <button
                type="button"
                class="relative flex items-center justify-center w-7 h-7 bg-transparent border-none rounded-md cursor-pointer transition-all duration-100 hover:bg-surface-2"
                classList={{
                  "text-foreground bg-surface-2/70": isActive(),
                  "text-muted-foreground hover:text-foreground": !isActive(),
                }}
                onClick={() => handleClick(window)}
                title={titleFor(window)}
                aria-label={titleFor(window)}
              >
                <Switch>
                  <Match when={window.kind === "agent"}>
                    <span class="text-[13px] leading-none">{"\u{1F916}"}</span>
                  </Match>
                  <Match when={window.kind === "terminal"}>
                    <TerminalIcon size={13} strokeWidth={1.4} />
                  </Match>
                  <Match when={window.kind === "editor"}>
                    <EditorIcon size={13} strokeWidth={1.4} />
                  </Match>
                  <Match when={window.kind === "chat"}>
                    <span class="text-[13px] leading-none">{"\u{1F4AC}"}</span>
                  </Match>
                </Switch>
                <Show when={status() === "running"}>
                  <span
                    class="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-status-running shadow-[0_0_4px_var(--status-running)] animate-pulse"
                    aria-hidden="true"
                  />
                </Show>
                <Show when={status() === "waiting-input"}>
                  <span
                    class="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-status-waiting shadow-[0_0_4px_var(--status-waiting)] animate-pulse"
                    aria-hidden="true"
                  />
                </Show>
                <Show when={status() === "error"}>
                  <span
                    class="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-status-error"
                    aria-hidden="true"
                  />
                </Show>
              </button>
            );
          }}
        </For>
      </div>
    </Show>
  );
};
