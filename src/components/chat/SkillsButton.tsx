// ABOUTME: Composer-bar launcher for the slash palette + one-click recent-skill re-invoke.
// ABOUTME: Renders as a split control when the thread has a recent skill, single button otherwise.

import { type Component, Show } from "solid-js";
import type { InstalledSkill } from "@/lib/skills";
import { skillsStore } from "@/stores/skills.store";

interface SkillsButtonProps {
  /**
   * Most recently invoked skill in the current thread, derived by the parent
   * from the conversation transcript. `null` when no skill has been used yet
   * in this thread; the component renders the single-button shape in that
   * case.
   */
  recentSkill?: InstalledSkill | null;
  /**
   * Open the slash palette. The parent typically sets the composer input to
   * "/" and focuses the textarea so the existing palette opens above it.
   */
  onLaunch: () => void;
  /**
   * Recall the recent skill into the composer — sets the input to `/slug `
   * (trailing space, cursor at end), focuses the textarea. Does NOT submit;
   * the user adds any args and hits Enter when ready. Matches the chip-click
   * behaviour in the transcript so both surfaces feel symmetric. Only called
   * when `recentSkill` is non-null.
   */
  onRecall?: (skill: InstalledSkill) => void;
}

function SkillsGlyph(props: { class?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      stroke-width="1.85"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={props.class}
    >
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="10"
      height="10"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export const SkillsButton: Component<SkillsButtonProps> = (props) => {
  const installedCount = () =>
    skillsStore.installed.filter(
      (skill) => skill.enabled && skill.payloadStatus !== "failed",
    ).length;

  return (
    <Show
      when={props.recentSkill}
      fallback={
        <button
          type="button"
          aria-label="Open skills"
          title="Open the skills palette (or type / in the composer)"
          class="flex items-center gap-2 px-3 py-1.5 bg-popover border border-muted rounded-md text-sm text-foreground cursor-pointer transition-colors hover:border-muted-foreground/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={(event) => {
            event.preventDefault();
            props.onLaunch();
          }}
        >
          <SkillsGlyph />
          <span class="text-foreground">Skills</span>
          <Show when={installedCount() > 0}>
            <span class="text-[10px] text-muted-foreground tabular-nums">
              {installedCount()}
            </span>
          </Show>
        </button>
      }
    >
      {(recent) => (
        <div
          role="group"
          aria-label="Skills"
          class="inline-flex items-stretch bg-popover border border-muted rounded-md overflow-hidden transition-colors hover:border-muted-foreground/40 focus-within:border-muted-foreground/60"
        >
          <button
            type="button"
            aria-label={`Recall /${recent().slug} into the composer`}
            title={`Recall /${recent().slug} into the composer (Enter to send)`}
            class="flex items-center gap-2 pl-3 pr-2.5 py-1.5 bg-transparent border-none cursor-pointer text-sm text-foreground transition-colors hover:bg-surface-2/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onClick={(event) => {
              event.preventDefault();
              props.onRecall?.(recent());
            }}
          >
            <SkillsGlyph />
            <span class="font-mono text-foreground max-w-[160px] truncate">
              {recent().slug}
            </span>
          </button>
          <button
            type="button"
            aria-label="Open skills palette"
            title="Open the skills palette"
            class="flex items-center justify-center px-2 py-1.5 bg-transparent border-0 border-l border-l-muted/60 cursor-pointer text-muted-foreground transition-colors hover:bg-surface-2/60 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onClick={(event) => {
              event.preventDefault();
              props.onLaunch();
            }}
          >
            <ChevronGlyph />
          </button>
        </div>
      )}
    </Show>
  );
};
