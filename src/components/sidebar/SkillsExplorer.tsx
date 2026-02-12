// ABOUTME: Skills Explorer sidebar with installed skill folder trees and search.
// ABOUTME: Replaces the thread sidebar, embedding a collapsible File Explorer at the bottom.

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { type Component, createSignal, For, onMount, Show } from "solid-js";
import { openFileInTab } from "@/lib/files/service";
import type { InstalledSkill, Skill, SkillScope } from "@/lib/skills";
import { skills as skillsService } from "@/services/skills";
import { skillsStore } from "@/stores/skills.store";
import { FileExplorer } from "./FileExplorer";
import "./SkillsExplorer.css";

interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
}

interface SkillsExplorerProps {
  collapsed: boolean;
}

type SearchTab = "installed" | "available";

export const SkillsExplorer: Component<SkillsExplorerProps> = (props) => {
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchTab, setSearchTab] = createSignal<SearchTab>("installed");
  const [showFiles, setShowFiles] = createSignal(false);
  const [expandedSkills, setExpandedSkills] = createSignal<Set<string>>(
    new Set(),
  );
  const [skillChildren, setSkillChildren] = createSignal<
    Record<string, FileEntry[]>
  >({});

  onMount(() => {
    skillsStore.refresh();
  });

  // ── Skill tree expansion ────────────────────────

  const toggleSkill = async (skill: InstalledSkill) => {
    const expanded = new Set(expandedSkills());
    const skillDir = skill.path.replace(/\/SKILL\.md$/, "");

    if (expanded.has(skill.id)) {
      expanded.delete(skill.id);
    } else {
      expanded.add(skill.id);
      // Lazy-load children if not cached
      if (!skillChildren()[skill.id]) {
        try {
          const entries = await invoke<FileEntry[]>("list_directory", {
            path: skillDir,
          });
          setSkillChildren((prev) => ({ ...prev, [skill.id]: entries }));
        } catch {
          // Directory may not exist or be empty
          setSkillChildren((prev) => ({ ...prev, [skill.id]: [] }));
        }
      }
    }
    setExpandedSkills(expanded);
  };

  const handleFileClick = (path: string) => {
    openFileInTab(path);
    window.dispatchEvent(
      new CustomEvent("seren:open-panel", { detail: "editor" }),
    );
  };

  const handleSkillSelect = (skill: InstalledSkill) => {
    skillsStore.setSelected(skill.id);
  };

  // ── Upload / Download ───────────────────────────

  const handleUpload = async () => {
    const selected = await open({
      filters: [{ name: "Skill files", extensions: ["md"] }],
      multiple: false,
    });
    if (selected && typeof selected === "string") {
      try {
        const content = await invoke<string>("read_file", { path: selected });
        // Derive slug from filename
        const fileName = selected.split("/").pop() || "skill";
        const slug = fileName
          .replace(/\.md$/i, "")
          .toLowerCase()
          .replace(/\s+/g, "-");
        const skill: Skill = {
          id: `local:${slug}`,
          slug,
          name: slug,
          description: "Imported skill",
          source: "local",
          tags: [],
        };
        await skillsStore.install(skill, content, "seren");
      } catch (err) {
        console.error("Failed to upload skill:", err);
      }
    }
  };

  const handleDownload = async () => {
    const selected = skillsStore.selected;
    if (!selected || !("scope" in selected)) return;

    const content = await skillsService.readContent(selected as InstalledSkill);
    if (!content) return;

    const savePath = await save({
      defaultPath: `${selected.slug}-SKILL.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (savePath) {
      try {
        await invoke("write_file", { path: savePath, content });
      } catch (err) {
        console.error("Failed to save skill:", err);
      }
    }
  };

  // ── Search ──────────────────────────────────────

  const searchResults = () => {
    const q = searchQuery();
    if (!q) return [];
    if (searchTab() === "installed") {
      return skillsStore.installed.filter(
        (s) =>
          s.name.toLowerCase().includes(q.toLowerCase()) ||
          s.description.toLowerCase().includes(q.toLowerCase()),
      );
    }
    return skillsService.search(skillsStore.available, q);
  };

  const handleSearchInstall = async (skill: Skill) => {
    const content = await skillsService.fetchContent(skill);
    if (content) {
      await skillsStore.install(skill, content, "seren");
    }
  };

  // ── Scope label ─────────────────────────────────

  const scopeLabel = (scope: SkillScope) => {
    switch (scope) {
      case "seren":
        return "S";
      case "claude":
        return "C";
      case "project":
        return "P";
    }
  };

  // ── Render ──────────────────────────────────────

  return (
    <aside
      class="skills-explorer"
      classList={{ "skills-explorer--collapsed": props.collapsed }}
    >
      {/* Header */}
      <div class="skills-explorer__header">
        <span class="skills-explorer__title">Skills</span>
        <div class="skills-explorer__header-actions">
          <button
            type="button"
            class="skills-explorer__header-btn"
            onClick={handleUpload}
            title="Upload skill"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              role="img"
              aria-label="Upload"
            >
              <path
                d="M8 2v8M4 6l4-4 4 4M3 12h10"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            class="skills-explorer__header-btn"
            onClick={handleDownload}
            disabled={
              !skillsStore.selected ||
              !("scope" in (skillsStore.selected || {}))
            }
            title="Download skill"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              role="img"
              aria-label="Download"
            >
              <path
                d="M8 2v8M4 6l4 4 4-4M3 12h10"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            class="skills-explorer__header-btn"
            onClick={() => skillsStore.refresh()}
            disabled={skillsStore.isLoading}
            title="Refresh skills"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              role="img"
              aria-label="Refresh"
            >
              <path
                d="M2.5 8a5.5 5.5 0 019.3-4M13.5 8a5.5 5.5 0 01-9.3 4"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
              />
              <path
                d="M12 1v3h-3M4 12v3h3"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Installed skills with folder trees */}
      <div class="skills-explorer__installed">
        <Show when={skillsStore.isLoading}>
          <div class="skills-explorer__loading">Loading skills...</div>
        </Show>

        <Show
          when={!skillsStore.isLoading && skillsStore.installed.length === 0}
        >
          <div class="skills-explorer__empty">
            No skills installed yet. Upload a SKILL.md or search for available
            skills below.
          </div>
        </Show>

        <Show when={!skillsStore.isLoading && skillsStore.installed.length > 0}>
          <For each={skillsStore.installed}>
            {(skill) => (
              <div class="skills-explorer__skill">
                <button
                  type="button"
                  class="skills-explorer__skill-header"
                  classList={{
                    "skills-explorer__skill-header--selected":
                      skillsStore.selectedId === skill.id,
                  }}
                  onClick={() => {
                    handleSkillSelect(skill);
                    toggleSkill(skill);
                  }}
                >
                  {/* Chevron */}
                  <svg
                    class="skills-explorer__skill-chevron"
                    classList={{
                      "skills-explorer__skill-chevron--open":
                        expandedSkills().has(skill.id),
                    }}
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    role="img"
                    aria-label="Expand"
                  >
                    <path
                      d="M6 4l4 4-4 4"
                      stroke="currentColor"
                      stroke-width="1.2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                  {/* Folder icon */}
                  <svg
                    class="skills-explorer__skill-icon"
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    role="img"
                    aria-label="Skill folder"
                  >
                    <path
                      d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 2h5A1.5 1.5 0 0114 6.5v5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z"
                      stroke="currentColor"
                      stroke-width="1.2"
                    />
                  </svg>
                  <span class="skills-explorer__skill-name">{skill.name}</span>
                  <span class="skills-explorer__skill-scope">
                    {scopeLabel(skill.scope)}
                  </span>
                  <span
                    class="skills-explorer__skill-status"
                    classList={{
                      "skills-explorer__skill-status--enabled":
                        skillsStore.isEnabled(skill.id),
                      "skills-explorer__skill-status--disabled":
                        !skillsStore.isEnabled(skill.id),
                    }}
                  />
                </button>

                {/* Expanded folder tree */}
                <Show when={expandedSkills().has(skill.id)}>
                  <div class="skills-explorer__tree">
                    <Show
                      when={skillChildren()[skill.id]?.length}
                      fallback={
                        <div class="skills-explorer__loading">Loading...</div>
                      }
                    >
                      <For each={skillChildren()[skill.id]}>
                        {(entry) => (
                          <button
                            type="button"
                            class="skills-explorer__tree-item"
                            classList={{
                              "skills-explorer__tree-item--dir":
                                entry.is_directory,
                            }}
                            onClick={() => {
                              if (!entry.is_directory) {
                                handleFileClick(entry.path);
                              }
                            }}
                          >
                            <Show
                              when={entry.is_directory}
                              fallback={
                                <svg
                                  class="skills-explorer__tree-icon"
                                  width="14"
                                  height="14"
                                  viewBox="0 0 16 16"
                                  fill="none"
                                  role="img"
                                  aria-label="File"
                                >
                                  <path
                                    d="M4 2h5l3 3v9H4V2z"
                                    stroke="currentColor"
                                    stroke-width="1.2"
                                  />
                                  <path
                                    d="M9 2v3h3"
                                    stroke="currentColor"
                                    stroke-width="1.2"
                                  />
                                </svg>
                              }
                            >
                              <svg
                                class="skills-explorer__tree-icon"
                                width="14"
                                height="14"
                                viewBox="0 0 16 16"
                                fill="none"
                                role="img"
                                aria-label="Directory"
                              >
                                <path
                                  d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 2h5A1.5 1.5 0 0114 6.5v5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z"
                                  stroke="currentColor"
                                  stroke-width="1.2"
                                />
                              </svg>
                            </Show>
                            <span class="skills-explorer__tree-name">
                              {entry.name}
                            </span>
                          </button>
                        )}
                      </For>
                    </Show>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>

      {/* Search section */}
      <div class="skills-explorer__search-section">
        <input
          class="skills-explorer__search"
          type="text"
          placeholder="Search skills..."
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
        />

        <div class="skills-explorer__search-tabs">
          <button
            type="button"
            class="skills-explorer__search-tab"
            classList={{
              "skills-explorer__search-tab--active":
                searchTab() === "installed",
            }}
            onClick={() => setSearchTab("installed")}
          >
            Installed
          </button>
          <button
            type="button"
            class="skills-explorer__search-tab"
            classList={{
              "skills-explorer__search-tab--active":
                searchTab() === "available",
            }}
            onClick={() => setSearchTab("available")}
          >
            Available
          </button>
        </div>

        <Show when={searchQuery() && searchResults().length > 0}>
          <div class="skills-explorer__search-results">
            <For each={searchResults()}>
              {(skill) => (
                <button
                  type="button"
                  class="skills-explorer__search-item"
                  onClick={() => {
                    if (searchTab() === "available") {
                      handleSearchInstall(skill);
                    } else {
                      skillsStore.setSelected(skill.id);
                    }
                  }}
                >
                  <span class="skills-explorer__search-item-name">
                    {skill.name}
                  </span>
                  <span class="skills-explorer__search-item-desc">
                    {skill.description}
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>

      {/* Collapsible File Explorer */}
      <div class="skills-explorer__files-section">
        <button
          type="button"
          class="skills-explorer__files-header"
          onClick={() => setShowFiles((v) => !v)}
        >
          <svg
            class="skills-explorer__files-chevron"
            classList={{ "skills-explorer__files-chevron--open": showFiles() }}
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            role="img"
            aria-label="Toggle files"
          >
            <path
              d="M6 4l4 4-4 4"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          Files
        </button>
        <Show when={showFiles()}>
          <div class="skills-explorer__files-body">
            <FileExplorer />
          </div>
        </Show>
      </div>
    </aside>
  );
};
