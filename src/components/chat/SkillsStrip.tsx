// ABOUTME: Compact skills strip rendered above chat/agent composers.
// ABOUTME: Shows resolved effective skills for the current thread; opens the right panel for management.

import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
} from "solid-js";
import type { InstalledSkill } from "@/lib/skills";
import { skillsStore } from "@/stores/skills.store";

interface SkillsStripProps {
  projectRoot: string | null;
  threadId: string | null;
}

const VISIBLE_LIMIT = 9;

const SCOPE_LABEL: Record<"thread" | "project" | "global", string> = {
  thread: "Attached to this thread",
  project: "Project default",
  global: "Global default",
};

function openSkillsPanel(): void {
  window.dispatchEvent(
    new CustomEvent("seren:open-panel", { detail: "skills" }),
  );
}

function pillTitle(skill: InstalledSkill, scopeLabel: string): string {
  const description = skill.description?.trim();
  return description ? `${scopeLabel}\n\n${description}` : scopeLabel;
}

export const SkillsStrip: Component<SkillsStripProps> = (props) => {
  const skills = createMemo<InstalledSkill[]>(() =>
    skillsStore.getThreadSkills(props.projectRoot, props.threadId),
  );
  const scope = createMemo(() =>
    skillsStore.getThreadSkillsScope(props.projectRoot, props.threadId),
  );
  const scopeLabel = () => {
    const s = scope();
    return s ? SCOPE_LABEL[s] : "";
  };
  const [expanded, setExpanded] = createSignal(false);
  const visibleSkills = () =>
    expanded() ? skills() : skills().slice(0, VISIBLE_LIMIT);
  const hiddenCount = () => Math.max(0, skills().length - VISIBLE_LIMIT);
  const [detachingPath, setDetachingPath] = createSignal<string | null>(null);

  const baseSkillName = (skill: InstalledSkill) =>
    skill.displayName ?? skill.name;

  let lastContextKey = "";
  createEffect(() => {
    const contextKey = `${props.projectRoot ?? ""}:${props.threadId ?? ""}`;
    if (contextKey !== lastContextKey) {
      lastContextKey = contextKey;
      setExpanded(false);
      return;
    }
    if (hiddenCount() === 0) setExpanded(false);
  });

  const detachSkill = async (skill: InstalledSkill) => {
    const root = props.projectRoot;
    const id = props.threadId;
    if (!root || !id) return;
    setDetachingPath(skill.path);
    try {
      await skillsStore.detachSkillFromThread(root, id, skill.path);
    } catch (err) {
      console.error("[SkillsStrip] Failed to detach skill:", err);
    } finally {
      setDetachingPath(null);
    }
  };

  return (
    <Show when={props.projectRoot && props.threadId}>
      <div class="flex items-center flex-wrap gap-1.5 px-4 pt-2 pb-1.5 text-[12px]">
        <Show
          when={skills().length > 0}
          fallback={
            <button
              type="button"
              class="flex items-center gap-1 px-2 py-1 bg-transparent border border-dashed border-border/70 rounded-full text-[11px] text-muted-foreground cursor-pointer transition-colors hover:bg-surface-2 hover:text-foreground"
              onClick={openSkillsPanel}
              title="Attach a skill to this thread"
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="none"
                role="img"
                aria-label="Add"
              >
                <path
                  d="M8 3v10M3 8h10"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
              </svg>
              Add skills
            </button>
          }
        >
          <For each={visibleSkills()}>
            {(skill) => (
              <span
                class="inline-flex items-center bg-surface-2/70 border border-border/60 rounded-full text-[11px] text-foreground transition-colors hover:bg-surface-2 hover:border-border max-w-[200px]"
                classList={{
                  "opacity-50": detachingPath() === skill.path,
                }}
              >
                <button
                  type="button"
                  class="flex items-center gap-1.5 pl-2 pr-1 py-0.5 bg-transparent border-none text-inherit cursor-pointer min-w-0"
                  onClick={openSkillsPanel}
                  title={pillTitle(skill, scopeLabel())}
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 16 16"
                    fill="none"
                    class="shrink-0 text-muted-foreground"
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
                  <span class="truncate">{baseSkillName(skill)}</span>
                </button>
                <button
                  type="button"
                  class="flex items-center justify-center w-5 h-5 mr-0.5 bg-transparent border-none rounded-full text-muted-foreground cursor-pointer transition-colors hover:bg-surface-3 hover:text-foreground disabled:opacity-40 disabled:cursor-default"
                  onClick={() => void detachSkill(skill)}
                  disabled={detachingPath() === skill.path}
                  aria-label={`Remove ${baseSkillName(skill)} from this thread`}
                  title="Remove from this thread"
                >
                  <svg
                    width="9"
                    height="9"
                    viewBox="0 0 16 16"
                    fill="none"
                    role="img"
                    aria-label="Remove"
                  >
                    <path
                      d="M4 4l8 8M12 4l-8 8"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                    />
                  </svg>
                </button>
              </span>
            )}
          </For>
          <Show when={hiddenCount() > 0}>
            <button
              type="button"
              class="px-2 py-0.5 bg-transparent border border-border/60 rounded-full text-[11px] text-muted-foreground cursor-pointer transition-colors hover:bg-surface-2 hover:text-foreground"
              onClick={() => setExpanded((value) => !value)}
              title={skills()
                .slice(VISIBLE_LIMIT)
                .map(baseSkillName)
                .join(", ")}
            >
              <Show when={expanded()} fallback={<>+{hiddenCount()} more</>}>
                Show less
              </Show>
            </button>
          </Show>
          <button
            type="button"
            class="flex items-center gap-1 px-2 py-0.5 bg-transparent border border-dashed border-border/70 rounded-full text-[11px] text-muted-foreground cursor-pointer transition-colors hover:bg-surface-2 hover:text-foreground"
            onClick={openSkillsPanel}
            title="Manage skills for this thread"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="none"
              role="img"
              aria-label="Add"
            >
              <path
                d="M8 3v10M3 8h10"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
            Add Skill
          </button>
        </Show>
      </div>
    </Show>
  );
};
