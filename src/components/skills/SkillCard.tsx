// ABOUTME: Card component for displaying a skill in the browse/installed lists.
// ABOUTME: Shows skill name, description, tags, and source badge.

import { type Component, For, Show } from "solid-js";
import type { InstalledSkill, Skill, SkillSource } from "@/lib/skills";

interface SkillCardProps {
  skill: Skill | InstalledSkill;
  isSelected: boolean;
  isInstalled: boolean;
  onClick: () => void;
}

const SOURCE_COLORS: Record<SkillSource, string> = {
  seren: "bg-[rgba(99,102,241,0.2)] text-[#818cf8]",
  anthropic: "bg-[rgba(234,179,8,0.2)] text-[#fbbf24]",
  openai: "bg-[rgba(34,197,94,0.2)] text-[#22c55e]",
  community: "bg-[rgba(148,163,184,0.2)] text-[#94a3b8]",
  local: "bg-[rgba(59,130,246,0.2)] text-[#3b82f6]",
};

const SOURCE_LABELS: Record<SkillSource, string> = {
  seren: "Seren",
  anthropic: "Anthropic",
  openai: "OpenAI",
  community: "Community",
  local: "Local",
};

export const SkillCard: Component<SkillCardProps> = (props) => {
  const isInstalledSkill = () => "scope" in props.skill;

  return (
    <article
      class={`flex flex-col p-4 bg-[rgba(30,41,59,0.5)] border rounded-xl cursor-pointer transition-all hover:bg-[rgba(30,41,59,0.8)] hover:border-[rgba(148,163,184,0.3)] ${
        props.isSelected
          ? "border-[#6366f1] bg-[rgba(99,102,241,0.1)]"
          : "border-[rgba(148,163,184,0.15)]"
      }`}
      onClick={props.onClick}
    >
      <div class="flex items-start justify-between gap-3 mb-2">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-[18px]">📄</span>
          <h3 class="text-[14px] font-semibold text-white m-0 truncate">
            {props.skill.name}
          </h3>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <Show when={props.isInstalled}>
            <span
              class="flex items-center justify-center w-5 h-5 bg-[#22c55e] rounded-full text-[10px] text-white"
              title="Installed"
            >
              ✓
            </span>
          </Show>
          <span
            class={`px-2 py-0.5 rounded text-[10px] font-medium ${SOURCE_COLORS[props.skill.source]}`}
          >
            {SOURCE_LABELS[props.skill.source]}
          </span>
        </div>
      </div>

      <Show when={props.skill.author}>
        <p class="text-[11px] text-[#64748b] -mt-1 mb-2 m-0">
          by {props.skill.author}
        </p>
      </Show>

      <p class="text-[12px] text-[#94a3b8] leading-relaxed mb-3 m-0 line-clamp-2">
        {props.skill.description}
      </p>

      <Show when={props.skill.tags.length > 0}>
        <div class="flex flex-wrap gap-1.5 mt-auto">
          <For each={props.skill.tags.slice(0, 3)}>
            {(tag) => (
              <span class="px-2 py-0.5 bg-[rgba(148,163,184,0.1)] rounded text-[10px] text-[#94a3b8]">
                {tag}
              </span>
            )}
          </For>
          <Show when={props.skill.tags.length > 3}>
            <span class="px-2 py-0.5 text-[10px] text-[#64748b]">
              +{props.skill.tags.length - 3}
            </span>
          </Show>
        </div>
      </Show>

      <Show when={isInstalledSkill()}>
        <div class="flex items-center gap-2 mt-3 pt-3 border-t border-[rgba(148,163,184,0.1)]">
          <span class="text-[11px] text-[#64748b]">
            {(props.skill as InstalledSkill).scope === "seren"
              ? "Seren"
              : (props.skill as InstalledSkill).scope === "claude"
                ? "Claude Code"
                : "Project"}
          </span>
        </div>
      </Show>
    </article>
  );
};
