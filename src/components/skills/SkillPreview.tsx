// ABOUTME: Preview pane for displaying full skill content and install actions.
// ABOUTME: Shows skill metadata, raw content, and install/remove buttons.

import {
  type Component,
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js";
import type {
  InstalledSkill,
  Skill,
  SkillScope,
  SkillSource,
} from "@/lib/skills";
import { skills } from "@/services/skills";
import { skillsStore } from "@/stores/skills.store";

interface SkillPreviewProps {
  skill: Skill | InstalledSkill;
  onClose: () => void;
}

const SOURCE_LABELS: Record<SkillSource, string> = {
  seren: "Seren",
  anthropic: "Anthropic",
  openai: "OpenAI",
  community: "Community",
  local: "Local",
};

const SCOPE_LABELS: Record<SkillScope, string> = {
  seren: "Seren",
  claude: "Claude Code",
  project: "Project",
};

export const SkillPreview: Component<SkillPreviewProps> = (props) => {
  const [installing, setInstalling] = createSignal(false);
  const [showScopeMenu, setShowScopeMenu] = createSignal(false);
  const [showRemoveMenu, setShowRemoveMenu] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const isInstalledSkill = () => "scope" in props.skill;
  const isInstalled = () =>
    isInstalledSkill() || skillsStore.isInstalled(props.skill.id);

  /** All installations of this skill across scopes. */
  const installedInstances = () =>
    skillsStore.installed.filter((s) => s.slug === props.skill.slug);

  // Fetch content for preview
  const [content] = createResource(
    () => props.skill,
    async (skill) => {
      if ("path" in skill) {
        // Already installed - read from disk
        return skills.readContent(skill as InstalledSkill);
      }
      // Not installed - fetch from source
      return skills.fetchContent(skill);
    },
  );

  async function handleInstall(scope: SkillScope) {
    setShowScopeMenu(false);
    setInstalling(true);
    setError(null);

    try {
      const skillContent = content();
      if (!skillContent) {
        throw new Error("No content available to install");
      }

      await skillsStore.install(props.skill, skillContent, scope);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to install skill");
    } finally {
      setInstalling(false);
    }
  }

  async function handleRemove(instance: InstalledSkill) {
    setShowRemoveMenu(false);
    setError(null);
    try {
      await skillsStore.remove(instance);
      // Close preview if no installations remain
      if (installedInstances().length === 0) {
        props.onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove skill");
    }
  }

  function handleToggleEnabled() {
    if (!isInstalledSkill()) return;
    skillsStore.toggleEnabled(props.skill.id);
  }

  return (
    <aside class="w-[400px] border-l border-[rgba(148,163,184,0.1)] bg-[rgba(15,23,42,0.5)] flex flex-col overflow-hidden">
      <div class="flex items-center justify-between p-4 border-b border-[rgba(148,163,184,0.1)]">
        <h2 class="text-[16px] font-semibold text-white m-0 truncate">
          {props.skill.name}
        </h2>
        <button
          type="button"
          class="w-7 h-7 flex items-center justify-center bg-transparent border-none rounded text-[20px] text-[#64748b] cursor-pointer hover:bg-[rgba(148,163,184,0.1)] hover:text-white"
          onClick={props.onClose}
        >
          ×
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        {/* Metadata */}
        <div class="flex flex-col gap-2">
          <Show when={props.skill.author}>
            <p class="text-[13px] text-[#64748b] m-0">
              by {props.skill.author}
            </p>
          </Show>

          <p class="text-[14px] text-[#94a3b8] leading-relaxed m-0">
            {props.skill.description}
          </p>
        </div>

        {/* Tags */}
        <Show when={props.skill.tags.length > 0}>
          <div class="flex flex-col gap-2">
            <h4 class="text-[12px] font-semibold text-[#64748b] uppercase tracking-wide m-0">
              Tags
            </h4>
            <div class="flex flex-wrap gap-1.5">
              <For each={props.skill.tags}>
                {(tag) => (
                  <span class="px-2 py-0.5 bg-[rgba(148,163,184,0.1)] rounded text-[12px] text-[#94a3b8]">
                    {tag}
                  </span>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Source info */}
        <div class="flex flex-col gap-2">
          <h4 class="text-[12px] font-semibold text-[#64748b] uppercase tracking-wide m-0">
            Source
          </h4>
          <p class="text-[13px] text-[#94a3b8] m-0">
            {SOURCE_LABELS[props.skill.source]}
          </p>
          <p class="text-[13px] text-[#94a3b8] m-0">
            Slug:{" "}
            <code class="px-1.5 py-0.5 bg-[rgba(15,23,42,0.8)] rounded text-[12px] text-[#818cf8] font-mono">
              {props.skill.slug}
            </code>
          </p>
        </div>

        {/* Installed info */}
        <Show when={isInstalledSkill()}>
          <div class="flex flex-col gap-2">
            <h4 class="text-[12px] font-semibold text-[#64748b] uppercase tracking-wide m-0">
              Installation
            </h4>
            <p class="text-[13px] text-[#94a3b8] m-0">
              Scope: {SCOPE_LABELS[(props.skill as InstalledSkill).scope]}
            </p>
            <p class="text-[13px] text-[#94a3b8] m-0 break-all">
              Path: {(props.skill as InstalledSkill).path}
            </p>
          </div>
        </Show>

        {/* Content preview */}
        <div class="flex flex-col gap-2">
          <h4 class="text-[12px] font-semibold text-[#64748b] uppercase tracking-wide m-0">
            Content
          </h4>
          <Show
            when={!content.loading}
            fallback={
              <div class="flex items-center gap-2 p-4 bg-[rgba(30,41,59,0.5)] rounded-lg">
                <div class="loading-spinner-sm" />
                <span class="text-[13px] text-[#64748b]">
                  Loading content...
                </span>
              </div>
            }
          >
            <Show
              when={content()}
              fallback={
                <p class="text-[13px] text-[#64748b] m-0">
                  Content not available
                </p>
              }
            >
              <pre class="p-3 bg-[rgba(15,23,42,0.8)] rounded-lg text-[12px] text-[#94a3b8] font-mono overflow-x-auto whitespace-pre-wrap m-0 max-h-[300px] overflow-y-auto">
                {content()}
              </pre>
            </Show>
          </Show>
        </div>

        {/* Error display */}
        <Show when={error()}>
          <div class="p-3 bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] rounded-lg">
            <p class="text-[13px] text-[#f87171] m-0">{error()}</p>
          </div>
        </Show>
      </div>

      {/* Action buttons */}
      <div class="p-4 border-t border-[rgba(148,163,184,0.1)] flex flex-col gap-2">
        <Show
          when={isInstalledSkill()}
          fallback={
            <Show when={!isInstalled()}>
              <div class="relative">
                <button
                  type="button"
                  class="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-[#6366f1] border-none rounded-lg text-[14px] font-medium text-white cursor-pointer transition-all hover:bg-[#5558e3] disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={() => setShowScopeMenu(!showScopeMenu())}
                  disabled={installing() || !content()}
                >
                  <Show when={installing()} fallback={<>Install ▼</>}>
                    <div class="loading-spinner-sm" />
                    Installing...
                  </Show>
                </button>

                <Show when={showScopeMenu()}>
                  <div class="absolute bottom-full left-0 right-0 mb-1 bg-[rgba(30,41,59,0.95)] border border-[rgba(148,163,184,0.2)] rounded-lg overflow-hidden shadow-lg">
                    <button
                      type="button"
                      class="w-full px-4 py-2.5 text-left text-[13px] text-white bg-transparent border-none cursor-pointer hover:bg-[rgba(148,163,184,0.1)]"
                      onClick={() => handleInstall("seren")}
                    >
                      <span class="block font-medium">Seren (default)</span>
                      <span class="text-[11px] text-[#64748b]">
                        Only in Seren Desktop
                      </span>
                    </button>
                    <button
                      type="button"
                      class="w-full px-4 py-2.5 text-left text-[13px] text-white bg-transparent border-none cursor-pointer hover:bg-[rgba(148,163,184,0.1)]"
                      onClick={() => handleInstall("claude")}
                    >
                      <span class="block font-medium">Claude Code (shared)</span>
                      <span class="text-[11px] text-[#64748b]">
                        Available in Claude Code CLI too (~/.claude/skills/)
                      </span>
                    </button>
                    <button
                      type="button"
                      class="w-full px-4 py-2.5 text-left text-[13px] text-white bg-transparent border-none cursor-pointer hover:bg-[rgba(148,163,184,0.1)]"
                      onClick={() => handleInstall("project")}
                    >
                      <span class="block font-medium">Project</span>
                      <span class="text-[11px] text-[#64748b]">
                        Only in current project (.claude/skills/)
                      </span>
                    </button>
                  </div>
                </Show>
              </div>
            </Show>
          }
        >
          <div class="flex gap-2">
            <button
              type="button"
              class={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 border rounded-lg text-[14px] font-medium cursor-pointer transition-all ${
                skillsStore.isEnabled(props.skill.id)
                  ? "bg-[rgba(34,197,94,0.1)] border-[rgba(34,197,94,0.3)] text-[#22c55e] hover:bg-[rgba(34,197,94,0.2)]"
                  : "bg-[rgba(148,163,184,0.1)] border-[rgba(148,163,184,0.2)] text-[#94a3b8] hover:bg-[rgba(148,163,184,0.2)]"
              }`}
              onClick={handleToggleEnabled}
            >
              {skillsStore.isEnabled(props.skill.id) ? "Enabled ✓" : "Disabled"}
            </button>
            <div class="relative">
              <button
                type="button"
                class="px-4 py-2.5 bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] rounded-lg text-[14px] font-medium text-[#f87171] cursor-pointer transition-all hover:bg-[rgba(239,68,68,0.2)]"
                onClick={() => {
                  const instances = installedInstances();
                  if (instances.length <= 1) {
                    handleRemove(props.skill as InstalledSkill);
                  } else {
                    setShowRemoveMenu(!showRemoveMenu());
                  }
                }}
              >
                Remove{installedInstances().length > 1 ? " \u25BC" : ""}
              </button>

              <Show when={showRemoveMenu()}>
                <div class="absolute bottom-full right-0 mb-1 min-w-[220px] bg-[rgba(30,41,59,0.95)] border border-[rgba(148,163,184,0.2)] rounded-lg overflow-hidden shadow-lg">
                  <For each={installedInstances()}>
                    {(instance) => (
                      <button
                        type="button"
                        class="w-full px-4 py-2.5 text-left text-[13px] text-white bg-transparent border-none cursor-pointer hover:bg-[rgba(239,68,68,0.1)]"
                        onClick={() => handleRemove(instance)}
                      >
                        <span class="block font-medium">
                          {SCOPE_LABELS[instance.scope]}
                        </span>
                        <span class="text-[11px] text-[#64748b] block truncate">
                          {instance.path}
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </aside>
  );
};
