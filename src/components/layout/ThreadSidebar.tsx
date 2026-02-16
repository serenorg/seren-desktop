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
import type { InstalledSkill, Skill } from "@/lib/skills";
import type { AgentType } from "@/services/acp";
import { skills as skillsService } from "@/services/skills";
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
  const [skillsExpanded, setSkillsExpanded] = createSignal(true);
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

  const handleSkillThread = async (skill: InstalledSkill | Skill) => {
    // Skills can only be toggled on an active thread
    const activeThread = threadStore.activeThread;
    if (!activeThread) {
      console.warn("[ThreadSidebar] No active thread, cannot toggle skill");
      return;
    }

    const cwd = fileTreeState.rootPath;
    if (!cwd) {
      console.warn("[ThreadSidebar] No project root, cannot toggle skill");
      return;
    }

    setSpawning(true);
    try {
      // If skill is from marketplace (not installed), install it first
      let installedSkill: InstalledSkill;
      if ("scope" in skill && "path" in skill) {
        // Already installed
        installedSkill = skill as InstalledSkill;
      } else {
        // Marketplace skill - need to install first
        const marketplaceSkill = skill as Skill;
        const content = await skillsService.fetchContent(marketplaceSkill);
        if (!content) {
          console.error("[ThreadSidebar] Failed to fetch skill content");
          return;
        }
        await skillsStore.install(marketplaceSkill, content, "seren");
        await skillsStore.refreshInstalled();

        // Find the newly installed skill
        const found = skillsStore.installed.find(
          (s) => s.slug === marketplaceSkill.slug,
        );
        if (!found) {
          console.error("[ThreadSidebar] Skill installed but not found");
          return;
        }
        installedSkill = found;
      }

      // Toggle skill for the active thread (add if not present, remove if present)
      await skillsStore.toggleThreadSkill(
        cwd,
        activeThread.id,
        installedSkill.path,
      );

      console.log(
        "[ThreadSidebar] Toggled skill",
        installedSkill.slug,
        "for thread",
        activeThread.id,
      );

      // Clear search to show active skills (provides visual feedback)
      setLauncherQuery("");
    } finally {
      setSpawning(false);
    }
  };

  const _openSkillsManager = () => {
    // Open Settings page with Skills tab selected
    window.dispatchEvent(
      new CustomEvent("seren:open-settings", { detail: { tab: "skills" } }),
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

  /**
   * Check if a skill is active in the current thread.
   */
  const isSkillActiveInThread = (skill: InstalledSkill | Skill): boolean => {
    const thread = threadStore.activeThread;
    const cwd = fileTreeState.rootPath;
    if (!thread || !cwd) return false;

    if (!("scope" in skill && "slug" in skill)) return false;
    const installedSkill = skill as InstalledSkill;
    const skillPath = installedSkill.path;

    const activeSkills = skillsStore.getThreadSkills(cwd, thread.id);
    const isActive = activeSkills.some((s) => s.path === skillPath);

    console.log("[ThreadSidebar] isSkillActiveInThread:", {
      skillName: skill.name,
      skillPath,
      activeSkillsCount: activeSkills.length,
      isActive,
    });

    return isActive;
  };

  const filteredSkills = () => {
    const q = launcherQuery().toLowerCase().trim();
    const thread = threadStore.activeThread;
    const cwd = fileTreeState.rootPath;

    // If no search query, show only skills active for current thread
    if (!q) {
      if (!thread || !cwd) return [];
      return skillsStore.getThreadSkills(cwd, thread.id);
    }

    // When searching, include installed + available marketplace skills
    // Deduplicate installed skills by path (in case same skill is in multiple scopes)
    const uniqueInstalled = Array.from(
      new Map(skillsStore.installed.map((s) => [s.path, s])).values(),
    );
    const installedSlugs = new Set(uniqueInstalled.map((s) => s.slug));
    const allSkills = [
      ...uniqueInstalled,
      ...skillsStore.available.filter(
        (available) => !installedSlugs.has(available.slug),
      ),
    ];

    return allSkills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)),
    );
  };

  const _showJustChat = () => {
    const q = launcherQuery().toLowerCase().trim();
    if (!q) return true;
    return "just chat".includes(q) || "chat".includes(q);
  };

  const [_showAgentPicker, setShowAgentPicker] = createSignal(false);

  const currentAgentLabel = () => {
    if (threadStore.preferChat) return "Seren Agent";
    const agents = acpStore.availableAgents;
    const selected = agents.find(
      (a) => a.type === acpStore.selectedAgentType && a.available,
    );
    if (selected)
      return selected.type === "codex" ? "Codex Agent" : "Claude Agent";

    const claude = agents.find((a) => a.type === "claude-code" && a.available);
    if (claude) return "Claude Agent";
    const codex = agents.find((a) => a.type === "codex" && a.available);
    if (codex) return "Codex Agent";
    return "Seren Agent";
  };

  const _currentAgentIcon = () => {
    const label = currentAgentLabel();
    if (label === "Codex Agent") return "\u26A1";
    if (label === "Claude Agent") return "\u{1F916}";
    return "\u{1F4AC}";
  };

  const _availableAgentOptions = () =>
    acpStore.availableAgents.filter((a) => a.available);

  const _selectPreferredAgent = (agentType: AgentType) => {
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

      {/* New thread button */}
      <div class="px-3 py-2 shrink-0 relative" ref={launcherRef}>
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
          {spawning() ? "Starting..." : "New Agent"}
        </button>

        <Show when={showLauncher()}>
          <div class="absolute top-[calc(100%+4px)] left-3 right-3 bg-surface-2 border border-border rounded-lg z-20 shadow-lg animate-[slideDown_150ms_ease] overflow-hidden py-1">
            {/* Seren Agent (Chat) */}
            <button
              type="button"
              class="flex items-center gap-2.5 w-full py-2 px-3 bg-transparent border-none rounded-md text-foreground text-[13px] cursor-pointer transition-colors duration-100 hover:bg-surface-3 text-left"
              onClick={handleNewChat}
            >
              <span class="text-[14px]">{"\u{1F4AC}"}</span>
              <span class="font-medium">Seren Agent</span>
            </button>

            {/* Claude Agent */}
            <Show
              when={acpStore.availableAgents.some(
                (a) => a.type === "claude-code" && a.available,
              )}
            >
              <button
                type="button"
                class="flex items-center gap-2.5 w-full py-2 px-3 bg-transparent border-none rounded-md text-foreground text-[13px] cursor-pointer transition-colors duration-100 hover:bg-surface-3 text-left"
                onClick={async () => {
                  setShowLauncher(false);
                  const cwd = fileTreeState.rootPath;
                  if (!cwd) return;
                  await threadStore.createAgentThread("claude-code", cwd);
                }}
              >
                <span class="text-[14px]">{"\u{1F916}"}</span>
                <span class="font-medium">Claude Agent</span>
              </button>
            </Show>

            {/* Codex Agent */}
            <Show
              when={acpStore.availableAgents.some(
                (a) => a.type === "codex" && a.available,
              )}
            >
              <button
                type="button"
                class="flex items-center gap-2.5 w-full py-2 px-3 bg-transparent border-none rounded-md text-foreground text-[13px] cursor-pointer transition-colors duration-100 hover:bg-surface-3 text-left"
                onClick={async () => {
                  setShowLauncher(false);
                  const cwd = fileTreeState.rootPath;
                  if (!cwd) return;
                  await threadStore.createAgentThread("codex", cwd);
                }}
              >
                <span class="text-[14px]">{"\u26A1"}</span>
                <span class="font-medium">Codex Agent</span>
              </button>
            </Show>
          </div>
        </Show>
      </div>

      {/* Skills section */}
      <div class="shrink-0 border-b border-border/40">
        {/* Skills header */}
        <button
          type="button"
          class="flex items-center gap-2 w-full px-3 py-2 bg-transparent border-none text-left cursor-pointer transition-colors duration-100 hover:bg-surface-2 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => setSkillsExpanded((v) => !v)}
          disabled={!threadStore.activeThread}
          title={
            !threadStore.activeThread
              ? "Select a thread to manage skills"
              : undefined
          }
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
              "rotate-0": skillsExpanded(),
              "-rotate-90": !skillsExpanded(),
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
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            role="img"
            aria-label="Skills"
          >
            <path
              d="M8 2l1.5 3 3.5.5-2.5 2.5.5 3.5L8 10l-3 1.5.5-3.5L3 5.5l3.5-.5L8 2z"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linejoin="round"
            />
          </svg>
          <div class="flex-1 flex flex-col gap-0.5">
            <span class="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
              Skills
            </span>
            <Show when={threadStore.activeThread}>
              <span class="text-[10px] text-muted-foreground/70">
                {filteredSkills().length} active
                {threadStore.activeThread?.title
                  ? ` · ${threadStore.activeThread.title.length > 20 ? `${threadStore.activeThread.title.slice(0, 20)}…` : threadStore.activeThread.title}`
                  : ""}
              </span>
            </Show>
          </div>
        </button>

        {/* Skills content (search + list) */}
        <Show when={skillsExpanded()}>
          <div class="px-3 pb-2">
            {/* Search box */}
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search skills..."
              value={launcherQuery()}
              onInput={(e) => setLauncherQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setLauncherQuery("");
                }
              }}
              class="w-full px-3 py-2 text-[13px] bg-surface-2 border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            />

            {/* Create New Skill button */}
            <button
              type="button"
              class="flex items-center justify-center gap-2 w-full mt-2 py-2 px-3 bg-primary/8 border border-primary/15 rounded-md text-primary text-[13px] font-medium cursor-pointer transition-all duration-100 hover:bg-primary/15 hover:border-primary/25 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={!threadStore.activeThread}
              onClick={async () => {
                // Find Skill Creator in installed or available skills
                const skillCreator =
                  skillsStore.installed.find(
                    (s) => s.slug === "skill-creator",
                  ) ||
                  skillsStore.available.find((s) => s.slug === "skill-creator");

                if (skillCreator) {
                  // Activate skill-creator for the current thread
                  const cwd = fileTreeState.rootPath;
                  const thread = threadStore.activeThread;
                  if (!cwd || !thread) return;

                  // Check if skill-creator is already active
                  const isAlreadyActive = isSkillActiveInThread(skillCreator);

                  if (!isAlreadyActive) {
                    // Activate it if not already active
                    await handleSkillThread(skillCreator);
                  }

                  // Trigger the interactive chat with skill creator prompt
                  window.dispatchEvent(
                    new CustomEvent("seren:set-chat-input", {
                      detail: "What skill do you want to create today?",
                    }),
                  );
                }
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                aria-label="Plus icon"
                role="img"
              >
                <path d="M8 3v10M3 8h10" />
              </svg>
              <span>Create New Skill</span>
            </button>

            {/* Skills list */}
            <div class="mt-2 max-h-[300px] overflow-y-auto">
              <Show
                when={filteredSkills().length > 0}
                fallback={
                  <div class="w-full px-3 py-4 text-[13px] text-center text-muted-foreground">
                    No matching skills
                  </div>
                }
              >
                <For each={filteredSkills()}>
                  {(skill) => {
                    const isActive = isSkillActiveInThread(skill);
                    const isSearching = launcherQuery().trim().length > 0;

                    const handleClick = () => {
                      console.log("[ThreadSidebar] handleClick:", {
                        skillName: skill.name,
                        isActive,
                        isSearching,
                      });

                      if (isActive) {
                        // Active skill (in thread) = Invoke the skill
                        const skillSlug = "slug" in skill ? skill.slug : "";
                        console.log(
                          "[ThreadSidebar] Invoking skill:",
                          skillSlug,
                        );
                        if (skillSlug) {
                          window.dispatchEvent(
                            new CustomEvent("seren:set-chat-input", {
                              detail: {
                                text: `/${skillSlug} `,
                                autoSend: true,
                              },
                            }),
                          );
                        }
                      } else {
                        // Inactive skill (not in thread) = Add to thread
                        console.log("[ThreadSidebar] Adding skill to thread");
                        handleSkillThread(skill);
                      }
                    };

                    return (
                      <div class="relative group">
                        <button
                          type="button"
                          class="flex items-start gap-2 w-full px-2.5 py-2 mb-1 border rounded-md cursor-pointer text-left transition-all duration-100 disabled:opacity-50 disabled:cursor-not-allowed"
                          classList={{
                            "bg-primary/5 border-primary/20 hover:bg-primary/10":
                              isActive,
                            "bg-transparent border-transparent hover:bg-surface-2 hover:border-border":
                              !isActive,
                          }}
                          disabled={!threadStore.activeThread}
                          onClick={handleClick}
                          title={
                            isActive
                              ? "Click to invoke skill in chat"
                              : "Click to add to thread"
                          }
                        >
                          {/* Star icon - filled if active, outline if inactive */}
                          <span
                            class="w-5 h-5 flex items-center justify-center rounded shrink-0 mt-0.5 transition-colors"
                            classList={{
                              "bg-primary/15 text-primary": isActive,
                              "bg-surface-2 text-muted-foreground": !isActive,
                            }}
                          >
                            <svg
                              width="11"
                              height="11"
                              viewBox="0 0 16 16"
                              fill={isActive ? "currentColor" : "none"}
                              role="img"
                              aria-label={
                                isActive ? "Active skill" : "Inactive skill"
                              }
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
                            <div class="text-[13px] font-medium text-foreground">
                              {skill.name}
                              {isActive && isSearching && (
                                <span class="ml-1.5 text-[10px] text-primary font-semibold">
                                  ●
                                </span>
                              )}
                            </div>
                            <Show when={skill.description}>
                              <div class="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                                {skill.description}
                              </div>
                            </Show>
                          </div>
                        </button>

                        {/* X button for active skills */}
                        <Show when={isActive}>
                          <button
                            type="button"
                            class="absolute top-2 right-2 w-5 h-5 flex items-center justify-center rounded bg-muted text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity hover:bg-muted-foreground/20"
                            onClick={(e) => {
                              console.log(
                                "[ThreadSidebar] X button clicked:",
                                skill.name,
                              );
                              e.stopPropagation();
                              handleSkillThread(skill);
                            }}
                            title="Remove skill from thread"
                          >
                            <svg
                              width="10"
                              height="10"
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              role="img"
                              aria-label="Remove"
                            >
                              <path d="M12 4L4 12M4 4l8 8" />
                            </svg>
                          </button>
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </Show>
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
                      <div
                        class="group flex items-center gap-2 w-full py-2 px-2.5 bg-transparent border-none border-l-2 border-l-transparent rounded-lg cursor-pointer mb-0.5 text-left transition-all duration-150 hover:bg-surface-2/60"
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
