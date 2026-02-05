// ABOUTME: Installed tab for managing installed skills.
// ABOUTME: Shows list of installed skills with enable/disable and remove options.

import { type Component, createSignal, For, Show } from "solid-js";
import type { InstalledSkill } from "@/lib/skills";
import { skillsStore } from "@/stores/skills.store";
import { SkillCard } from "./SkillCard";

interface SkillsInstalledProps {
  onSelectSkill: (skill: InstalledSkill) => void;
  selectedId: string | null;
}

export const SkillsInstalled: Component<SkillsInstalledProps> = (props) => {
  const [filterScope, setFilterScope] = createSignal<
    "all" | "seren" | "claude" | "project"
  >("all");

  const filteredSkills = () => {
    const scope = filterScope();
    if (scope === "all") return skillsStore.installed;
    return skillsStore.installed.filter((s) => s.scope === scope);
  };

  const serenCount = () =>
    skillsStore.installed.filter((s) => s.scope === "seren").length;
  const claudeCount = () =>
    skillsStore.installed.filter((s) => s.scope === "claude").length;
  const projectCount = () =>
    skillsStore.installed.filter((s) => s.scope === "project").length;

  return (
    <div class="flex flex-col h-full">
      {/* Scope filter */}
      <div class="flex items-center gap-4 p-4 border-b border-[rgba(148,163,184,0.1)]">
        <div class="flex gap-2">
          <button
            type="button"
            class={`px-3 py-2 rounded-lg text-[13px] font-medium transition-all cursor-pointer border ${
              filterScope() === "all"
                ? "bg-[#6366f1] border-[#6366f1] text-white"
                : "bg-[rgba(30,41,59,0.5)] border-[rgba(148,163,184,0.15)] text-[#94a3b8] hover:bg-[rgba(30,41,59,0.8)] hover:text-white"
            }`}
            onClick={() => setFilterScope("all")}
          >
            All ({skillsStore.installed.length})
          </button>
          <button
            type="button"
            class={`px-3 py-2 rounded-lg text-[13px] font-medium transition-all cursor-pointer border ${
              filterScope() === "seren"
                ? "bg-[#6366f1] border-[#6366f1] text-white"
                : "bg-[rgba(30,41,59,0.5)] border-[rgba(148,163,184,0.15)] text-[#94a3b8] hover:bg-[rgba(30,41,59,0.8)] hover:text-white"
            }`}
            onClick={() => setFilterScope("seren")}
          >
            Seren ({serenCount()})
          </button>
          <button
            type="button"
            class={`px-3 py-2 rounded-lg text-[13px] font-medium transition-all cursor-pointer border ${
              filterScope() === "claude"
                ? "bg-[#6366f1] border-[#6366f1] text-white"
                : "bg-[rgba(30,41,59,0.5)] border-[rgba(148,163,184,0.15)] text-[#94a3b8] hover:bg-[rgba(30,41,59,0.8)] hover:text-white"
            }`}
            onClick={() => setFilterScope("claude")}
          >
            Claude ({claudeCount()})
          </button>
          <button
            type="button"
            class={`px-3 py-2 rounded-lg text-[13px] font-medium transition-all cursor-pointer border ${
              filterScope() === "project"
                ? "bg-[#6366f1] border-[#6366f1] text-white"
                : "bg-[rgba(30,41,59,0.5)] border-[rgba(148,163,184,0.15)] text-[#94a3b8] hover:bg-[rgba(30,41,59,0.8)] hover:text-white"
            }`}
            onClick={() => setFilterScope("project")}
          >
            Project ({projectCount()})
          </button>
        </div>

        <div class="ml-auto text-[13px] text-[#64748b]">
          {skillsStore.enabledSkills.length} enabled
        </div>
      </div>

      {/* Loading state */}
      <Show when={skillsStore.isLoading}>
        <div class="flex flex-col items-center justify-center gap-4 p-12">
          <div class="loading-spinner" />
          <p class="text-[#94a3b8] m-0">Loading installed skills...</p>
        </div>
      </Show>

      {/* Skills list */}
      <Show when={!skillsStore.isLoading}>
        <div class="flex-1 overflow-y-auto p-4">
          <Show
            when={filteredSkills().length > 0}
            fallback={
              <div class="flex flex-col items-center justify-center gap-3 p-12 text-center">
                <span class="text-[48px]">📦</span>
                <p class="text-white text-[16px] m-0">No skills installed</p>
                <p class="text-[#64748b] text-[14px] m-0">
                  {filterScope() !== "all"
                    ? `No ${filterScope()} scope skills installed`
                    : "Browse the catalog to discover and install skills"}
                </p>
              </div>
            }
          >
            <div class="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
              <For each={filteredSkills()}>
                {(skill) => (
                  <div class="relative">
                    <SkillCard
                      skill={skill}
                      isSelected={props.selectedId === skill.id}
                      isInstalled={true}
                      onClick={() => props.onSelectSkill(skill)}
                    />
                    {/* Quick enable/disable toggle */}
                    <button
                      type="button"
                      class={`absolute top-3 right-3 w-6 h-6 flex items-center justify-center rounded-full transition-all cursor-pointer border ${
                        skillsStore.isEnabled(skill.id)
                          ? "bg-[#22c55e] border-[#22c55e] text-white"
                          : "bg-[rgba(148,163,184,0.2)] border-[rgba(148,163,184,0.3)] text-[#64748b]"
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        skillsStore.toggleEnabled(skill.id);
                      }}
                      title={
                        skillsStore.isEnabled(skill.id)
                          ? "Click to disable"
                          : "Click to enable"
                      }
                    >
                      {skillsStore.isEnabled(skill.id) ? "✓" : "○"}
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
};
