// ABOUTME: Composer button that syncs the chat's active skill to its latest
// ABOUTME: upstream revision; the parent renders it only when a sync is needed.

import { type Component, Show } from "solid-js";
import type { InstalledSkill } from "@/lib/skills";
import { skillsStore } from "@/stores/skills.store";

interface SyncSkillButtonProps {
  /** The chat's active skill, already determined to need a sync by the parent. */
  skill: InstalledSkill;
  /**
   * Trigger the sync. The parent runs `skillsStore.syncInstalledSkill`, which
   * shows the changes/confirmation popup before applying.
   */
  onSync: () => void;
}

function SyncGlyph(props: { class?: string }) {
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
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}

export const SyncSkillButton: Component<SyncSkillButtonProps> = (props) => {
  const loading = () => skillsStore.isSyncLoading(props.skill.path);

  return (
    <button
      type="button"
      aria-label={`Sync /${props.skill.slug} to the latest version`}
      title={`/${props.skill.slug} has an update available — click to review the changes and sync`}
      disabled={loading()}
      class="flex items-center gap-2 px-3 py-1.5 bg-warning/10 border border-warning/40 rounded-md text-sm font-medium text-warning cursor-pointer transition-colors hover:bg-warning/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-60 disabled:cursor-default"
      onClick={(event) => {
        event.preventDefault();
        if (loading()) return;
        props.onSync();
      }}
    >
      <SyncGlyph class={loading() ? "animate-spin" : undefined} />
      <Show when={loading()} fallback={<span>Sync Skill</span>}>
        <span>Syncing…</span>
      </Show>
    </button>
  );
};
