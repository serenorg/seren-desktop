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
import type { InstalledSkill } from "@/lib/skills";
import type { AgentType } from "@/services/acp";
import { acpStore } from "@/stores/acp.store";
import { fileTreeState, setRootPath } from "@/stores/fileTree";
import { skillsStore } from "@/stores/skills.store";
import { type Thread, threadStore } from "@/stores/thread.store";

interface ThreadSidebarProps {
  collapsed: boolean;
  onToggle?: () => void;
}

export const ThreadSidebar: Component<ThreadSidebarProps> = (props) => {
  const [showLauncher, setShowLauncher] = createSignal(false);
  const [launcherQuery, setLauncherQuery] = createSignal("");
  const [collapsedGroups, setCollapsedGroups] = createSignal<
    Set<string | null>
  >(new Set());
  const [spawning, setSpawning] = createSignal(false);
  let launcherRef: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;

  const folderName = () => {
    const root = fileTreeState.rootPath;
    if (!root) return null;
    return root.split("/").pop() || root;
  };

  const handleClickOutside = (e: MouseEvent) => {
    if (
      showLauncher() &&
      launcherRef &&
      !launcherRef.contains(e.target as Node)
    ) {
      setShowLauncher(false);
      setLauncherQuery("");
      setShowAgentPicker(false);
    }
  };

  onMount(() => {
    document.addEventListener("mousedown", handleClickOutside);
    void skillsStore.refreshInstalled();
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
    setShowLauncher(false);
    setLauncherQuery("");
    setSpawning(true);
    try {
      await threadStore.createChatThread();
    } finally {
      setSpawning(false);
    }
  };

  const handleSkillThread = async (skill: InstalledSkill) => {
    setShowLauncher(false);
    setLauncherQuery("");
    setSpawning(true);
    try {
      await threadStore.createSkillThread(skill);
    } finally {
      setSpawning(false);
    }
  };

  const openSkillsManager = () => {
    setShowLauncher(false);
    setLauncherQuery("");
    window.dispatchEvent(
      new CustomEvent("seren:open-panel", { detail: "skills" }),
    );
  };

  const toggleLauncher = () => {
    const opening = !showLauncher();
    setShowLauncher(opening);
    setShowAgentPicker(false);
    if (opening) {
      setLauncherQuery("");
      requestAnimationFrame(() => searchInputRef?.focus());
    }
  };

  const filteredSkills = () => {
    const installed = skillsStore.enabledSkills;
    const q = launcherQuery().toLowerCase().trim();
    if (!q) return installed;
    return installed.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)),
    );
  };

  const showJustChat = () => {
    const q = launcherQuery().toLowerCase().trim();
    if (!q) return true;
    return "just chat".includes(q) || "chat".includes(q);
  };

  const [showAgentPicker, setShowAgentPicker] = createSignal(false);

  const currentAgentLabel = () => {
    if (threadStore.preferChat) return "Chat";
    const agents = acpStore.availableAgents;
    const selected = agents.find(
      (a) => a.type === acpStore.selectedAgentType && a.available,
    );
    if (selected) return selected.type === "codex" ? "Codex" : "Claude";

    const claude = agents.find((a) => a.type === "claude-code" && a.available);
    if (claude) return "Claude";
    const codex = agents.find((a) => a.type === "codex" && a.available);
    if (codex) return "Codex";
    return "Chat";
  };

  const currentAgentIcon = () => {
    const label = currentAgentLabel();
    if (label === "Codex") return "\u26A1";
    if (label === "Claude") return "\u{1F916}";
    return "\u{1F4AC}";
  };

  const availableAgentOptions = () =>
    acpStore.availableAgents.filter((a) => a.available);

  const selectPreferredAgent = (agentType: AgentType) => {
    threadStore.setPreferChat(false);
    acpStore.setSelectedAgentType(agentType);
    setShowAgentPicker(false);
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

      {/* New thread launcher */}
      <div class="px-3 py-2 relative shrink-0" ref={launcherRef}>
        <button
          type="button"
          class="flex items-center gap-2 w-full py-2 px-3 bg-primary/8 border border-primary/15 rounded-lg text-primary text-[13px] font-medium cursor-pointer transition-all duration-150 hover:bg-primary/15 hover:border-primary/25 hover:shadow-[0_0_12px_rgba(56,189,248,0.1)] active:scale-[0.98] disabled:opacity-60 disabled:cursor-wait disabled:hover:bg-primary/8"
          onClick={toggleLauncher}
          disabled={spawning()}
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
          {spawning() ? "Starting agent..." : "New Thread"}
        </button>

        <Show when={showLauncher()}>
          <div class="absolute top-[calc(100%-4px)] left-3 right-3 bg-surface-2 border border-border rounded-lg z-20 shadow-lg animate-[slideDown_150ms_ease] overflow-hidden">
            {/* Search */}
            <div class="px-2 pt-2 pb-1.5">
              <div class="relative">
                <svg
                  class="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  role="img"
                  aria-label="Search"
                >
                  <circle
                    cx="7"
                    cy="7"
                    r="4.5"
                    stroke="currentColor"
                    stroke-width="1.3"
                  />
                  <path
                    d="M10.5 10.5L14 14"
                    stroke="currentColor"
                    stroke-width="1.3"
                    stroke-linecap="round"
                  />
                </svg>
                <input
                  ref={searchInputRef}
                  type="text"
                  class="w-full pl-7 pr-2.5 py-1.5 bg-surface-1 border border-border/60 rounded-md text-[12px] text-foreground placeholder-muted-foreground outline-none focus:border-primary/50 transition-colors"
                  placeholder="Search skills..."
                  value={launcherQuery()}
                  onInput={(e) => setLauncherQuery(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setShowLauncher(false);
                      setLauncherQuery("");
                    }
                  }}
                />
              </div>
            </div>

            {/* Just Chat option */}
            <div class="px-1 pb-0.5">
              <Show when={showJustChat()}>
                <button
                  type="button"
                  class="flex items-center gap-2.5 w-full py-2 px-2.5 bg-transparent border-none rounded-md text-foreground text-[13px] cursor-pointer transition-colors duration-100 hover:bg-surface-3"
                  onClick={handleNewChat}
                >
                  <span class="w-5 h-5 flex items-center justify-center rounded bg-surface-3/80 shrink-0">
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 16 16"
                      fill="none"
                      role="img"
                      aria-label="Chat"
                    >
                      <path
                        d="M2 4a2 2 0 012-2h8a2 2 0 012 2v5a2 2 0 01-2 2H7l-3 2.5V11H4a2 2 0 01-2-2V4z"
                        stroke="currentColor"
                        stroke-width="1.2"
                      />
                    </svg>
                  </span>
                  <span class="font-medium">Just Chat</span>
                </button>
              </Show>
            </div>

            {/* Skills list */}
            <Show when={filteredSkills().length > 0}>
              <div class="border-t border-border/40 mx-2" />
              <div class="max-h-[220px] overflow-y-auto px-1 py-0.5">
                <For each={filteredSkills()}>
                  {(skill) => (
                    <button
                      type="button"
                      class="flex items-center gap-2.5 w-full py-2 px-2.5 bg-transparent border-none rounded-md text-foreground text-[13px] cursor-pointer transition-colors duration-100 hover:bg-surface-3 text-left"
                      onClick={() => handleSkillThread(skill)}
                    >
                      <span class="w-5 h-5 flex items-center justify-center rounded bg-primary/10 text-primary shrink-0">
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 16 16"
                          fill="none"
                          role="img"
                          aria-label="Skill"
                        >
                          <path
                            d="M8 2L9.5 6H14L10.5 8.5L12 13L8 10L4 13L5.5 8.5L2 6H6.5L8 2Z"
                            stroke="currentColor"
                            stroke-width="1.2"
                            stroke-linejoin="round"
                          />
                        </svg>
                      </span>
                      <div class="flex-1 min-w-0">
                        <span class="block truncate font-medium">
                          {skill.name}
                        </span>
                        <Show when={skill.description}>
                          <span class="block text-[11px] text-muted-foreground truncate">
                            {skill.description}
                          </span>
                        </Show>
                      </div>
                    </button>
                  )}
                </For>
              </div>
            </Show>

            {/* Empty state when searching */}
            <Show
              when={
                filteredSkills().length === 0 &&
                !showJustChat() &&
                launcherQuery()
              }
            >
              <div class="px-3 py-4 text-center text-[12px] text-muted-foreground">
                No matching skills
              </div>
            </Show>

            {/* Footer: agent selector + manage skills */}
            <div class="border-t border-border/40 mx-0 flex items-center">
              {/* Agent selector */}
              <div class="relative">
                <button
                  type="button"
                  class="flex items-center gap-1.5 py-2 px-3 bg-transparent border-none text-[12px] text-muted-foreground cursor-pointer transition-colors duration-100 hover:bg-surface-3 hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowAgentPicker((v) => !v);
                  }}
                  title="Default agent for new threads"
                >
                  <span class="text-[12px]">{currentAgentIcon()}</span>
                  <span>{currentAgentLabel()}</span>
                  <svg
                    width="8"
                    height="8"
                    viewBox="0 0 16 16"
                    fill="none"
                    role="img"
                    aria-label="Change agent"
                  >
                    <path
                      d="M4 6l4 4 4-4"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </button>

                <Show when={showAgentPicker()}>
                  <div class="absolute left-0 bottom-[calc(100%+4px)] min-w-[140px] bg-surface-1 border border-border rounded-lg shadow-lg z-30 py-1 animate-[fadeIn_100ms_ease]">
                    <For each={availableAgentOptions()}>
                      {(agent) => (
                        <button
                          type="button"
                          class="flex items-center gap-2 w-full px-3 py-1.5 bg-transparent border-none text-[12px] text-foreground cursor-pointer transition-colors hover:bg-surface-3 text-left"
                          classList={{
                            "!text-primary":
                              !threadStore.preferChat &&
                              agent.type === acpStore.selectedAgentType,
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            selectPreferredAgent(agent.type as AgentType);
                          }}
                        >
                          <span class="text-[12px]">
                            {agent.type === "codex" ? "\u26A1" : "\u{1F916}"}
                          </span>
                          <span>{agent.name}</span>
                          <Show
                            when={
                              !threadStore.preferChat &&
                              agent.type === acpStore.selectedAgentType
                            }
                          >
                            <svg
                              class="ml-auto"
                              width="12"
                              height="12"
                              viewBox="0 0 16 16"
                              fill="none"
                              role="img"
                              aria-label="Selected"
                            >
                              <path
                                d="M3 8l3.5 3.5L13 4"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                              />
                            </svg>
                          </Show>
                        </button>
                      )}
                    </For>
                    {/* Seren Chat option */}
                    <button
                      type="button"
                      class="flex items-center gap-2 w-full px-3 py-1.5 bg-transparent border-none text-[12px] text-foreground cursor-pointer transition-colors hover:bg-surface-3 text-left"
                      classList={{
                        "!text-primary": threadStore.preferChat,
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        threadStore.setPreferChat(true);
                        setShowAgentPicker(false);
                      }}
                    >
                      <span class="text-[12px]">{"\u{1F4AC}"}</span>
                      <span>Seren</span>
                      <Show when={threadStore.preferChat}>
                        <svg
                          class="ml-auto"
                          width="12"
                          height="12"
                          viewBox="0 0 16 16"
                          fill="none"
                          role="img"
                          aria-label="Selected"
                        >
                          <path
                            d="M3 8l3.5 3.5L13 4"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                      </Show>
                    </button>
                  </div>
                </Show>
              </div>

              <div class="w-px h-4 bg-border/40" />

              {/* Manage skills */}
              <button
                type="button"
                class="flex items-center gap-1.5 flex-1 py-2 px-3 bg-transparent border-none text-[12px] text-muted-foreground cursor-pointer transition-colors duration-100 hover:bg-surface-3 hover:text-foreground"
                onClick={openSkillsManager}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 16 16"
                  fill="none"
                  role="img"
                  aria-label="Manage"
                >
                  <circle
                    cx="8"
                    cy="8"
                    r="2.5"
                    stroke="currentColor"
                    stroke-width="1.2"
                  />
                  <path
                    d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41"
                    stroke="currentColor"
                    stroke-width="1.2"
                    stroke-linecap="round"
                  />
                </svg>
                Skills...
              </button>
            </div>
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
