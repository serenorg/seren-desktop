// ABOUTME: Main skills panel with tabbed interface for browse and installed views.
// ABOUTME: Provides skill discovery, installation, and management functionality.

import { type Component, createSignal, onMount, Show } from "solid-js";
import type { InstalledSkill, Skill } from "@/lib/skills";
import { skillsStore } from "@/stores/skills.store";
import { SkillPreview } from "./SkillPreview";
import { SkillsBrowser } from "./SkillsBrowser";
import { SkillsInstalled } from "./SkillsInstalled";

type Tab = "browse" | "installed";

export const SkillsPanel: Component = () => {
  const [activeTab, setActiveTab] = createSignal<Tab>("browse");
  const [selectedSkill, setSelectedSkill] = createSignal<
    Skill | InstalledSkill | null
  >(null);

  // Load skills on mount
  onMount(() => {
    skillsStore.refresh();
  });

  function handleSelectSkill(skill: Skill | InstalledSkill) {
    setSelectedSkill(skill);
    skillsStore.setSelected(skill.id);
  }

  function handleClosePreview() {
    setSelectedSkill(null);
    skillsStore.setSelected(null);
  }

  function handleRefresh() {
    skillsStore.clearCacheAndRefresh();
  }

  return (
    <div class="flex flex-col h-full bg-transparent">
      {/* Header */}
      <header class="p-6 pb-4 border-b border-[rgba(148,163,184,0.1)]">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-2xl font-semibold text-white m-0">Skills</h1>
            <p class="text-[14px] text-[#94a3b8] mt-1 m-0">
              Discover and manage SKILL.md-based capabilities for your AI
              assistant.
            </p>
          </div>
          <button
            type="button"
            class="px-3 py-2 bg-[rgba(30,41,59,0.5)] border border-[rgba(148,163,184,0.15)] rounded-lg text-[13px] font-medium text-[#94a3b8] cursor-pointer transition-all hover:bg-[rgba(30,41,59,0.8)] hover:text-white"
            onClick={handleRefresh}
            title="Refresh skills index"
          >
            ↻ Refresh
          </button>
        </div>
      </header>

      {/* Tabs */}
      <div class="flex border-b border-[rgba(148,163,184,0.1)]">
        <button
          type="button"
          class={`px-6 py-3 text-[14px] font-medium cursor-pointer transition-all border-b-2 ${
            activeTab() === "browse"
              ? "text-white border-[#6366f1] bg-transparent"
              : "text-[#94a3b8] border-transparent hover:text-white bg-transparent"
          }`}
          onClick={() => setActiveTab("browse")}
        >
          Browse
        </button>
        <button
          type="button"
          class={`px-6 py-3 text-[14px] font-medium cursor-pointer transition-all border-b-2 ${
            activeTab() === "installed"
              ? "text-white border-[#6366f1] bg-transparent"
              : "text-[#94a3b8] border-transparent hover:text-white bg-transparent"
          }`}
          onClick={() => setActiveTab("installed")}
        >
          Installed ({skillsStore.installed.length})
        </button>
      </div>

      {/* Content area with preview */}
      <div class="flex flex-1 overflow-hidden">
        {/* Main content */}
        <div class="flex-1 overflow-hidden">
          <Show when={activeTab() === "browse"}>
            <SkillsBrowser
              onSelectSkill={handleSelectSkill}
              selectedId={selectedSkill()?.id ?? null}
            />
          </Show>
          <Show when={activeTab() === "installed"}>
            <SkillsInstalled
              onSelectSkill={handleSelectSkill}
              selectedId={selectedSkill()?.id ?? null}
            />
          </Show>
        </div>

        {/* Preview pane */}
        <Show when={selectedSkill()}>
          {(skill) => (
            <SkillPreview skill={skill()} onClose={handleClosePreview} />
          )}
        </Show>
      </div>
    </div>
  );
};

export default SkillsPanel;
