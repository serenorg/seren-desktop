// ABOUTME: Browse tab for discovering and installing skills.
// ABOUTME: Shows searchable grid of available skills with filtering.

import {
  type Component,
  createEffect,
  createSignal,
  For,
  Show,
} from "solid-js";
import type { Skill, SkillSource } from "@/lib/skills";
import { skills } from "@/services/skills";
import { skillsStore } from "@/stores/skills.store";
import { SkillCard } from "./SkillCard";

interface SkillsBrowserProps {
  onSelectSkill: (skill: Skill) => void;
  selectedId: string | null;
}

const SOURCES: { id: SkillSource | null; label: string }[] = [
  { id: null, label: "All" },
  { id: "seren", label: "Seren" },
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "community", label: "Community" },
];

export const SkillsBrowser: Component<SkillsBrowserProps> = (props) => {
  const [searchQuery, setSearchQuery] = createSignal("");
  const [selectedSource, setSelectedSource] = createSignal<SkillSource | null>(
    null,
  );
  const [selectedTag, setSelectedTag] = createSignal<string | null>(null);
  const [filteredSkills, setFilteredSkills] = createSignal<Skill[]>([]);

  // Get all unique tags from available skills
  const allTags = () => skills.getAllTags(skillsStore.available);

  // Filter skills based on search, source, and tag
  createEffect(() => {
    let filtered = skillsStore.available;

    // Filter by source
    filtered = skills.filterBySource(filtered, selectedSource());

    // Filter by tag
    filtered = skills.filterByTag(filtered, selectedTag());

    // Filter by search query
    filtered = skills.search(filtered, searchQuery());

    setFilteredSkills(filtered);
  });

  function handleSourceClick(source: SkillSource | null) {
    setSelectedSource(source);
  }

  function handleTagClick(tag: string) {
    setSelectedTag((prev) => (prev === tag ? null : tag));
  }

  return (
    <div class="flex flex-col h-full">
      {/* Search and filters */}
      <div class="flex items-center gap-4 p-4 border-b border-[rgba(148,163,184,0.1)] flex-wrap">
        <div class="min-w-[200px] max-w-[350px]">
          <input
            type="text"
            placeholder="Search skills..."
            value={searchQuery()}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
            class="w-full px-4 py-2.5 bg-[rgba(15,23,42,0.6)] border border-[rgba(148,163,184,0.2)] rounded-lg text-[14px] text-white placeholder:text-[#64748b] outline-none transition-colors focus:border-[#6366f1]"
          />
        </div>
        <div class="flex gap-2 flex-wrap">
          <For each={SOURCES}>
            {(source) => (
              <button
                type="button"
                class={`px-3 py-2 rounded-lg text-[13px] font-medium transition-all cursor-pointer border ${
                  selectedSource() === source.id
                    ? "bg-[#6366f1] border-[#6366f1] text-white"
                    : "bg-[rgba(30,41,59,0.5)] border-[rgba(148,163,184,0.15)] text-[#94a3b8] hover:bg-[rgba(30,41,59,0.8)] hover:text-white"
                }`}
                onClick={() => handleSourceClick(source.id)}
              >
                {source.label}
              </button>
            )}
          </For>
        </div>
      </div>

      {/* Tag filters */}
      <Show when={allTags().length > 0}>
        <div class="flex items-center gap-2 px-4 py-2 border-b border-[rgba(148,163,184,0.1)] overflow-x-auto">
          <span class="text-[12px] text-[#64748b] shrink-0">Tags:</span>
          <div class="flex gap-1.5">
            <For each={allTags().slice(0, 10)}>
              {(tag) => (
                <button
                  type="button"
                  class={`px-2 py-1 rounded text-[11px] transition-all cursor-pointer border ${
                    selectedTag() === tag
                      ? "bg-[rgba(99,102,241,0.2)] border-[rgba(99,102,241,0.4)] text-[#818cf8]"
                      : "bg-transparent border-[rgba(148,163,184,0.15)] text-[#94a3b8] hover:bg-[rgba(148,163,184,0.1)]"
                  }`}
                  onClick={() => handleTagClick(tag)}
                >
                  {tag}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* Loading state */}
      <Show when={skillsStore.isLoading}>
        <div class="flex flex-col items-center justify-center gap-4 p-12">
          <div class="loading-spinner" />
          <p class="text-[#94a3b8] m-0">Loading skills...</p>
        </div>
      </Show>

      {/* Error state */}
      <Show when={skillsStore.error}>
        <div class="m-6 p-4 bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] rounded-lg flex items-center justify-between">
          <p class="text-[#f87171] m-0">{skillsStore.error}</p>
          <button
            type="button"
            onClick={() => skillsStore.refreshAvailable()}
            class="px-3 py-1.5 bg-[rgba(239,68,68,0.2)] border-none rounded text-[#f87171] cursor-pointer hover:bg-[rgba(239,68,68,0.3)]"
          >
            Retry
          </button>
        </div>
      </Show>

      {/* Skills grid */}
      <Show when={!skillsStore.isLoading && !skillsStore.error}>
        <div class="flex-1 overflow-y-auto p-4">
          <Show
            when={filteredSkills().length > 0}
            fallback={
              <div class="flex flex-col items-center justify-center gap-3 p-12 text-center">
                <span class="text-[48px]">📚</span>
                <p class="text-white text-[16px] m-0">No skills found</p>
                <p class="text-[#64748b] text-[14px] m-0">
                  {searchQuery() || selectedSource() || selectedTag()
                    ? "Try adjusting your search or filters"
                    : "Skills will appear here once the index is loaded"}
                </p>
              </div>
            }
          >
            <div class="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
              <For each={filteredSkills()}>
                {(skill) => (
                  <SkillCard
                    skill={skill}
                    isSelected={props.selectedId === skill.id}
                    isInstalled={skillsStore.isInstalled(skill.id)}
                    onClick={() => props.onSelectSkill(skill)}
                  />
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
};
