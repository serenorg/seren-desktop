// ABOUTME: Thread-aware skills picker for project defaults and per-thread overrides.
// ABOUTME: Defaults to project scope and allows optional thread-specific customization.

import {
  type Component,
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { Skill } from "@/lib/skills";
import { skills as skillsService } from "@/services/skills";
import { fileTreeState } from "@/stores/fileTree";
import { skillsStore } from "@/stores/skills.store";
import { threadStore } from "@/stores/thread.store";

const SKILL_CREATOR_SLUG = "seren-skill-creator";
const SKILL_CREATOR_SOURCE_URL =
  "https://raw.githubusercontent.com/serenorg/skills/main/seren/skill-creator/SKILL.md";

export const SkillsSelector: Component = () => {
  const [isOpen, setIsOpen] = createSignal(false);
  const [threadMode, setThreadMode] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;

  const projectRoot = () => fileTreeState.rootPath;
  const threadId = () => threadStore.activeThreadId;
  const allInstalled = () => skillsStore.installed;
  const canUseThreadMode = () => Boolean(projectRoot() && threadId());

  createEffect(() => {
    const root = projectRoot();
    const id = threadId();
    void skillsStore.ensureContextLoaded(root, id);
    if (!id) setThreadMode(false);
  });

  const activeSkills = () =>
    threadMode()
      ? skillsStore.getThreadSkills(projectRoot(), threadId())
      : skillsStore.getProjectSkills(projectRoot());

  const hasOverride = () =>
    threadMode()
      ? skillsStore.hasThreadOverride(projectRoot(), threadId())
      : skillsStore.hasProjectOverride(projectRoot());

  const isSkillActive = (skillPath: string) =>
    activeSkills().some((s) => s.path === skillPath);

  const toggleSkill = (skillPath: string) => {
    const root = projectRoot();
    if (!root) return;

    if (threadMode() && threadId()) {
      void skillsStore.toggleThreadSkill(root, threadId() as string, skillPath);
      return;
    }

    void skillsStore.toggleProjectSkill(root, skillPath);
  };

  const resetToDefaults = () => {
    const root = projectRoot();
    if (!root) return;

    if (threadMode() && threadId()) {
      void skillsStore.resetThreadSkills(root, threadId() as string);
      return;
    }

    void skillsStore.resetProjectSkills(root);
  };

  const openSkillsManager = () => {
    setIsOpen(false);
    window.dispatchEvent(
      new CustomEvent("seren:open-panel", { detail: "skills" }),
    );
  };

  const handleCreateNewSkill = async () => {
    setIsOpen(false);

    // Ensure Skill Creator is installed
    const alreadyInstalled = skillsStore.installed.some(
      (s) => s.slug === SKILL_CREATOR_SLUG,
    );

    if (!alreadyInstalled) {
      try {
        const skill: Skill = {
          id: `serenorg:${SKILL_CREATOR_SLUG}`,
          slug: SKILL_CREATOR_SLUG,
          name: "Skill Creator",
          description:
            "Guide for creating effective skills. Use when users want to create or update a skill that extends capabilities with specialized knowledge, workflows, or tool integrations.",
          source: "serenorg",
          sourceUrl: SKILL_CREATOR_SOURCE_URL,
          tags: ["meta", "creation"],
          author: "SerenAI",
        };
        const content = await skillsService.fetchContent(skill);
        if (content) {
          await skillsStore.install(skill, content, "seren");
        }
      } catch (err) {
        console.error("[SkillsSelector] Failed to install skill-creator:", err);
      }
    }

    // Set the chat input to the skill creation prompt
    window.dispatchEvent(
      new CustomEvent("seren:set-chat-input", {
        detail: "What skill do you want to create today?",
      }),
    );
  };

  const handleDocumentClick = (event: MouseEvent) => {
    if (!isOpen()) return;
    if (
      containerRef &&
      event.target instanceof Node &&
      !containerRef.contains(event.target)
    ) {
      setIsOpen(false);
    }
  };

  onMount(() => {
    document.addEventListener("click", handleDocumentClick);
  });

  onCleanup(() => {
    document.removeEventListener("click", handleDocumentClick);
  });

  return (
    <div class="relative" ref={containerRef}>
      <button
        type="button"
        class="flex items-center gap-1.5 px-2.5 py-1.5 bg-popover border border-muted rounded-md text-sm text-foreground cursor-pointer transition-colors hover:border-muted-foreground/40"
        onClick={() => setIsOpen(!isOpen())}
        title="Select active skills"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          role="img"
          aria-label="Skills"
        >
          <path
            d="M8 2L9.5 6H14L10.5 8.5L12 13L8 10L4 13L5.5 8.5L2 6H6.5L8 2Z"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linejoin="round"
          />
        </svg>
        <span class="max-w-[110px] overflow-hidden text-ellipsis whitespace-nowrap">
          {activeSkills().length} Skill{activeSkills().length !== 1 ? "s" : ""}
        </span>
        <Show when={hasOverride()}>
          <span class="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
        </Show>
        <span class="text-[10px] text-muted-foreground">
          {isOpen() ? "\u25B2" : "\u25BC"}
        </span>
      </button>

      <Show when={isOpen()}>
        <div class="absolute bottom-[calc(100%+8px)] left-0 min-w-[240px] max-w-[320px] bg-surface-2 border border-surface-3 rounded-lg shadow-[var(--shadow-lg)] z-[1000] overflow-hidden animate-[fadeInUp_150ms_ease]">
          <div class="px-3 py-2 bg-surface-3/50 border-b border-surface-3 flex items-center justify-between gap-3">
            <span class="text-xs font-medium text-muted-foreground">
              {threadMode() ? "Skills for this thread" : "Project defaults"}
            </span>
            <Show when={canUseThreadMode()}>
              <button
                type="button"
                class="px-2 py-0.5 rounded border border-surface-3 text-[11px] text-muted-foreground hover:text-foreground hover:border-muted-foreground/40"
                onClick={() => setThreadMode((v) => !v)}
                title="Toggle thread-specific customization"
              >
                {threadMode() ? "Thread" : "Project"}
              </button>
            </Show>
          </div>

          <Show when={hasOverride()}>
            <button
              type="button"
              class="w-full flex items-center gap-2 px-3 py-2 bg-transparent border-none border-b border-b-surface-3 text-left text-[13px] text-primary cursor-pointer transition-colors hover:bg-border"
              onClick={resetToDefaults}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                role="img"
                aria-label="Reset"
              >
                <path
                  d="M2 8a6 6 0 1011.5 2.5"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linecap="round"
                />
                <path
                  d="M2 3v5h5"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              Reset to defaults
            </button>
          </Show>

          <div class="max-h-[280px] overflow-y-auto py-1">
            <Show
              when={allInstalled().length > 0}
              fallback={
                <button
                  type="button"
                  class="w-full px-3 py-4 bg-transparent border-none text-center text-[13px] text-primary cursor-pointer transition-colors hover:bg-border hover:text-primary/80"
                  onClick={handleCreateNewSkill}
                >
                  No skills found. Click to create a new skill
                </button>
              }
            >
              <For each={allInstalled()}>
                {(skill) => (
                  <button
                    type="button"
                    class="w-full flex items-start gap-2.5 px-3 py-2 bg-transparent border-none text-left text-[13px] cursor-pointer transition-colors hover:bg-border"
                    onClick={() => toggleSkill(skill.path)}
                  >
                    <div
                      class="w-4 h-4 mt-0.5 shrink-0 rounded border flex items-center justify-center transition-colors"
                      classList={{
                        "bg-primary border-primary": isSkillActive(skill.path),
                        "bg-transparent border-muted-foreground/40":
                          !isSkillActive(skill.path),
                      }}
                    >
                      <Show when={isSkillActive(skill.path)}>
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 16 16"
                          fill="none"
                          role="img"
                          aria-label="Active"
                        >
                          <path
                            d="M3 8l3.5 3.5L13 4"
                            stroke="var(--primary-foreground)"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                      </Show>
                    </div>

                    <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                      <span class="text-foreground font-medium truncate">
                        {skill.name}
                      </span>
                      <Show when={skill.description}>
                        <span class="text-[11px] text-muted-foreground line-clamp-1">
                          {skill.description}
                        </span>
                      </Show>
                    </div>
                  </button>
                )}
              </For>
            </Show>
          </div>

          <button
            type="button"
            class="w-full px-3 py-2 bg-transparent border-none border-t border-t-surface-3 text-left text-[12px] text-muted-foreground cursor-pointer transition-colors hover:bg-border hover:text-foreground"
            onClick={openSkillsManager}
          >
            Manage Skills...
          </button>
        </div>
      </Show>
    </div>
  );
};

export default SkillsSelector;
