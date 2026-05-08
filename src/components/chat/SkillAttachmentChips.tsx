// ABOUTME: Compact skill chips for the composer attachment row.
// ABOUTME: Shows persistent thread skills alongside one-shot file attachments.

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

interface SkillAttachmentChipsProps {
  projectRoot: string | null;
  threadId: string | null;
}

const VISIBLE_SKILLS = 3;

function skillName(skill: InstalledSkill): string {
  return skill.displayName ?? skill.name;
}

export const SkillAttachmentChips: Component<SkillAttachmentChipsProps> = (
  props,
) => {
  const [detachingPath, setDetachingPath] = createSignal<string | null>(null);

  createEffect(() => {
    const projectRoot = props.projectRoot;
    const threadId = props.threadId;
    if (!projectRoot || !threadId) return;
    void skillsStore.ensureContextLoaded(projectRoot, threadId);
  });

  const activeSkills = createMemo<InstalledSkill[]>(() =>
    skillsStore.getThreadSkills(props.projectRoot, props.threadId),
  );

  const hasThreadOverride = createMemo(() =>
    skillsStore.hasThreadOverride(props.projectRoot, props.threadId),
  );

  const visibleSkills = () => activeSkills().slice(0, VISIBLE_SKILLS);
  const hiddenCount = () => Math.max(0, activeSkills().length - VISIBLE_SKILLS);
  const actionLabel = () => (hasThreadOverride() ? "Remove" : "Exclude");
  const scopeTitle = () =>
    hasThreadOverride()
      ? "Attached to this thread"
      : "Inherited from project or global defaults";

  const detachSkill = async (skill: InstalledSkill) => {
    const projectRoot = props.projectRoot;
    const threadId = props.threadId;
    if (!projectRoot || !threadId) return;
    setDetachingPath(skill.path);
    try {
      await skillsStore.detachSkillFromThread(
        projectRoot,
        threadId,
        skill.path,
      );
    } catch (error) {
      console.error("[SkillAttachmentChips] Failed to detach skill:", error);
    } finally {
      setDetachingPath(null);
    }
  };

  return (
    <>
      <For each={visibleSkills()}>
        {(skill) => (
          <span
            class="inline-flex items-center gap-1 pl-1.5 pr-1 py-0.5 rounded-md border border-primary/25 bg-primary/10 text-[11px] text-primary max-w-[180px]"
            title={`Skill: ${skillName(skill)} - ${scopeTitle()}. Persists across messages on this thread.`}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="none"
              class="shrink-0"
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
            <span class="truncate">{skillName(skill)}</span>
            <button
              type="button"
              class="shrink-0 bg-transparent border-none rounded text-primary/70 hover:text-primary cursor-pointer text-[12px] leading-none px-0.5 disabled:opacity-40"
              onClick={() => void detachSkill(skill)}
              disabled={detachingPath() === skill.path}
              title={`${actionLabel()} ${skillName(skill)} for this thread`}
              aria-label={`${actionLabel()} ${skillName(skill)}`}
            >
              {detachingPath() === skill.path ? "..." : "x"}
            </button>
          </span>
        )}
      </For>

      <Show when={hiddenCount() > 0}>
        <button
          type="button"
          class="px-2 py-0.5 rounded-md border border-primary/20 bg-primary/5 text-[11px] text-primary cursor-pointer hover:bg-primary/10"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("seren:open-panel", { detail: "skills" }),
            )
          }
          title={activeSkills().slice(VISIBLE_SKILLS).map(skillName).join(", ")}
        >
          +{hiddenCount()} skills
        </button>
      </Show>
    </>
  );
};
